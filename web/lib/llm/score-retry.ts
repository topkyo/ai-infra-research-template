import {
  isStrictLlmOutputError,
  sleep,
  strictOutputRepairMessages,
} from "./strict";
import { chatDetailed } from "./transport";
import type { ChatMessage } from "./types";

export type ScoreRetryOptions = {
  messages: ChatMessage[];
  model: string;
  timeoutMs?: number;
  configuredAttempts: number;
  bypassCache?: boolean;
};

export async function chatWithScoreRetry<T>(
  opts: ScoreRetryOptions,
  handleResponse: (content: string, cacheHit: boolean) => T,
): Promise<T> {
  const attempts = opts.bypassCache ? 1 : opts.configuredAttempts;
  let lastError: unknown;
  let strictRetryUsed = false;
  let attemptMessages = opts.messages;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await chatDetailed(attemptMessages, {
        model: opts.model,
        responseFormat: "json_object",
        temperature: attempt === 0 ? 0.2 : 0,
        bypassCache: opts.bypassCache || attempt > 0 || attemptMessages !== opts.messages,
        timeoutMs: opts.timeoutMs,
      });
      if (!result.content.trim()) {
        throw new Error("LLM returned empty content");
      }
      return handleResponse(result.content, result.cacheHit);
    } catch (e) {
      lastError = e;
      const canUseConfiguredRetry = attempt < attempts - 1;
      const canUseStrictRetry = !opts.bypassCache && !strictRetryUsed && isStrictLlmOutputError(e);
      if (canUseStrictRetry && !canUseConfiguredRetry) {
        strictRetryUsed = true;
      }
      if (canUseConfiguredRetry || canUseStrictRetry) {
        if (isStrictLlmOutputError(e)) {
          attemptMessages = strictOutputRepairMessages(opts.messages, e);
        }
        await sleep(500 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastError;
}
