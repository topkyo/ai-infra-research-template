import { buildRuleFeatures } from "../scoring/rules";
import type {
  ChatMessage,
  PortfolioScoringSnapshot,
  PortfolioTargetSignal,
  Signal,
  SignalSource,
  SymbolSnapshot,
} from "./types";

export const MIN_SCORABLE_KLINES = 10;
export const DEFAULT_SCORE_BATCH_SIZE = 10;
export const VALID_ACTIONS = new Set(["buy", "hold", "sell"]);

export function envPositiveNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function normalizeRationale(value: unknown): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : "LLM未提供理由";
  return text.slice(0, 60);
}

export function normalizeShortText(value: unknown, field: string, symbol: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`LLM portfolio signal ${symbol} missing ${field}`);
  }
  return value.trim().slice(0, 80);
}

export function normalizeShortTextArray(value: unknown, field: string, symbol: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`LLM portfolio signal ${symbol} missing ${field}`);
  }
  const out = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => item.slice(0, 80));
  if (out.length === 0) {
    throw new Error(`LLM portfolio signal ${symbol} missing ${field}`);
  }
  return out;
}

export function strictWeight(value: unknown, field: string, symbol: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`LLM portfolio signal ${symbol} invalid ${field}: ${String(value)}`);
  }
  return Number(value.toFixed(6));
}

export function strictSignalField(value: unknown, field: string, symbol: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`LLM signal ${symbol} invalid ${field}: ${String(value)}`);
  }
  return Number(value.toFixed(3));
}

export function chunks<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) out.push(items.slice(i, i + safeSize));
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signalSource(cacheHit: boolean): SignalSource {
  return cacheHit ? "llm-cache" : "llm-live";
}

export function isStrictLlmOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    "LLM returned invalid JSON",
    "LLM response missing signals array",
    "LLM response missing symbols",
    "LLM returned unknown symbol",
    "LLM returned duplicate symbol",
    "LLM returned invalid action",
    "LLM signal item must be an object",
    "LLM signal ",
    "LLM portfolio signal item must be an object",
    "LLM portfolio signal",
  ].some((marker) => error.message.includes(marker));
}

export function strictOutputRepairMessages(messages: ChatMessage[], error: unknown): ChatMessage[] {
  const reason = error instanceof Error ? error.message : String(error);
  return [
    ...messages,
    {
      role: "user",
      content: [
        `上一次输出未通过严格 JSON 校验：${reason}`,
        "请重新输出完整 JSON，不要解释，不要省略任何输入 symbol。",
        "每个 signals item 都必须包含全部必填字段，portfolio 输出尤其必须包含非空 evidence 数组和非空 risks 数组。",
        "如果某只股票证据不足，也必须在 evidence 中写明基于哪些已给字段或数据缺口形成该判断，不得留空或省略字段。",
      ].join("\n"),
    },
  ];
}

export function normalizeLlmSignals(
  raw: string,
  batch: SymbolSnapshot[],
  source: SignalSource,
): Signal[] {
  let parsed: { signals?: unknown };
  try {
    parsed = JSON.parse(raw) as { signals?: unknown };
  } catch (e) {
    throw new Error(`LLM returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed.signals)) {
    throw new Error("LLM response missing signals array");
  }

  const expected = new Set(batch.map((s) => s.symbol));
  const featuresBySymbol = new Map(batch.map((s) => [s.symbol, buildRuleFeatures(s)]));
  const seen = new Set<string>();
  const out: Signal[] = [];

  for (const item of parsed.signals) {
    if (!item || typeof item !== "object") {
      throw new Error("LLM signal item must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const symbol = typeof candidate.symbol === "string" ? candidate.symbol.trim() : "";
    if (!expected.has(symbol)) {
      throw new Error(`LLM returned unknown symbol ${symbol || "<empty>"}`);
    }
    if (seen.has(symbol)) {
      throw new Error(`LLM returned duplicate symbol ${symbol}`);
    }
    seen.add(symbol);

    const action = typeof candidate.action === "string" ? candidate.action : "";
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`LLM returned invalid action for ${symbol}: ${action || "<empty>"}`);
    }

    out.push({
      symbol,
      action: action as Signal["action"],
      confidence: strictSignalField(candidate.confidence, "confidence", symbol),
      size: strictSignalField(candidate.size, "size", symbol),
      rationale: normalizeRationale(candidate.rationale),
      source,
      dataQuality: featuresBySymbol.get(symbol)?.dataMissingFlags ?? [],
    });
  }

  const missing = [...expected].filter((symbol) => !seen.has(symbol));
  if (missing.length > 0) {
    throw new Error(`LLM response missing symbols: ${missing.join(",")}`);
  }

  const bySymbol = new Map(out.map((signal) => [signal.symbol, signal]));
  return batch.map((snapshot) => bySymbol.get(snapshot.symbol)!);
}

export function normalizePortfolioSignals(
  raw: string,
  batch: PortfolioScoringSnapshot[],
  source: SignalSource,
): PortfolioTargetSignal[] {
  let parsed: { signals?: unknown };
  try {
    parsed = JSON.parse(raw) as { signals?: unknown };
  } catch (e) {
    throw new Error(`LLM returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed.signals)) {
    throw new Error("LLM response missing signals array");
  }

  const expected = new Set(batch.map((s) => s.symbol));
  const featuresBySymbol = new Map(batch.map((s) => [s.symbol, buildRuleFeatures(s)]));
  const seen = new Set<string>();
  const out: PortfolioTargetSignal[] = [];

  for (const item of parsed.signals) {
    if (!item || typeof item !== "object") {
      throw new Error("LLM portfolio signal item must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const symbol = typeof candidate.symbol === "string" ? candidate.symbol.trim() : "";
    if (!expected.has(symbol)) {
      throw new Error(`LLM returned unknown symbol ${symbol || "<empty>"}`);
    }
    if (seen.has(symbol)) {
      throw new Error(`LLM returned duplicate symbol ${symbol}`);
    }
    seen.add(symbol);

    out.push({
      symbol,
      targetWeight: strictWeight(candidate.targetWeight, "targetWeight", symbol),
      confidence: strictWeight(candidate.confidence, "confidence", symbol),
      rationale: normalizeShortText(candidate.rationale, "rationale", symbol),
      evidence: normalizeShortTextArray(candidate.evidence, "evidence", symbol),
      risks: normalizeShortTextArray(candidate.risks, "risks", symbol),
      invalidation: normalizeShortText(candidate.invalidation, "invalidation", symbol),
      source,
      dataQuality: featuresBySymbol.get(symbol)?.dataMissingFlags ?? [],
    });
  }

  const missing = [...expected].filter((symbol) => !seen.has(symbol));
  if (missing.length > 0) {
    throw new Error(`LLM response missing symbols: ${missing.join(",")}`);
  }

  const bySymbol = new Map(out.map((signal) => [signal.symbol, signal]));
  return batch.map((snapshot) => bySymbol.get(snapshot.symbol)!);
}
