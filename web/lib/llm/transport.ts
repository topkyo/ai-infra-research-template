import { cachedWithMeta } from "../cache";
import { llmApiKeyConfigured, resolveLlmConfig } from "./config";
import type { ChatMessage, ChatOptions, ChatResult } from "./types";

export class LlmHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${provider} ${status}: ${body}`);
  }
}

export function truncateErrorBody(body: string): string {
  const text = body.trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/** Network / undici codes worth a transport retry. Config bugs (e.g. ERR_INVALID_URL) stay out. */
export const RETRYABLE_CAUSE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

export function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof LlmHttpError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (error instanceof TypeError) {
    // undici: TypeError("fetch failed") for many network failures.
    if (error.message === "fetch failed") return true;
    const cause = (error as { cause?: unknown }).cause;
    const code = (cause as { code?: unknown } | null | undefined)?.code;
    if (typeof code !== "string") return false;
    return RETRYABLE_CAUSE_CODES.has(code) || code.startsWith("UND_ERR_");
  }
  return false;
}

/** Backoff for transport retries: honor Retry-After when present, else linear + jitter. */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null | undefined): number {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 60_000);
    const dateMs = Date.parse(retryAfterHeader);
    if (!Number.isNaN(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), 60_000);
  }
  const base = 750 * (attempt + 1);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

export function extractMessageContent(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  const reasoning = message.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning;
  return "";
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatDetailed(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const cfg = resolveLlmConfig();
  if (!llmApiKeyConfigured(cfg)) {
    throw new Error(
      cfg.provider === "mock"
        ? "LLM_PROVIDER=mock: this code path has no mock implementation"
        : cfg.provider === "opencode-go"
          ? "OPENCODE_GO_API_KEY is not set"
          : "DEEPSEEK_API_KEY is not set",
    );
  }
  const model = opts.model ?? cfg.model;
  const temperature = opts.temperature ?? 0.2;
  const responseFormat = opts.responseFormat ?? "text";
  const ttl = opts.ttlSeconds ?? 12 * 3600;

  const cacheParts = {
    provider: cfg.provider,
    model,
    temperature,
    responseFormat,
    messages,
  };
  const llmTimeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  const transportMaxAttempts = opts.transportMaxAttempts
    ?? envPositiveInt("LLM_TRANSPORT_MAX_ATTEMPTS", 3);

  const doFetch = async () => {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      stream: false,
    };
    if (responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < transportMaxAttempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), llmTimeoutMs);
      try {
        const r = await fetch(cfg.chatCompletionsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!r.ok) {
          const retryAfter = r.headers.get("retry-after");
          lastError = new LlmHttpError(cfg.provider, r.status, truncateErrorBody(await r.text()));
          if (attempt < transportMaxAttempts - 1 && isRetryableTransportError(lastError)) {
            // Clear before sleeping so the abort timer cannot fire mid-backoff.
            clearTimeout(timer);
            await sleep(retryDelayMs(attempt, retryAfter));
            continue;
          }
          break;
        }
        // Keep the abort timer armed through body read — a stalled stream
        // should not hang past llmTimeoutMs (and in-flight cache joiners).
        const j = (await r.json()) as {
          choices?: { message?: Record<string, unknown> }[];
        };
        const content = extractMessageContent(j.choices?.[0]?.message);
        if (!content.trim()) {
          throw new Error(`${cfg.provider} returned empty content`);
        }
        return content;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new Error(`${cfg.provider} timed out after ${llmTimeoutMs}ms`);
        }
        lastError = e;
        if (attempt < transportMaxAttempts - 1 && isRetryableTransportError(e)) {
          clearTimeout(timer);
          await sleep(retryDelayMs(attempt, null));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (transportMaxAttempts > 1 && isRetryableTransportError(lastError)) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`${cfg.provider} transport failed after ${transportMaxAttempts} attempts: ${message}`);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  if (opts.bypassCache) {
    return { content: await doFetch(), cacheHit: false };
  }
  const result = await cachedWithMeta(cacheParts, ttl, doFetch);
  return { content: result.value, cacheHit: result.cacheHit };
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  return (await chatDetailed(messages, opts)).content;
}
