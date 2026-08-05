// DeepSeek v4 client with strict strategy-output validation.
//
// Strategy boundary:
//   1. Rule code ranks candidates and annotates data quality.
//   2. LLM is the buy/hold/sell decision source for ranked candidates.
//   3. Deterministic code validates LLM output and enforces portfolio rules.
import { resolveLlmConfig } from "./llm/config";
import { PORTFOLIO_STRATEGY_SYSTEM, STRATEGY_SYSTEM } from "./llm/prompts";
import {
  chat,
  chatDetailed,
  isRetryableTransportError,
  LlmHttpError,
  retryDelayMs,
} from "./llm/transport";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  PortfolioPositionInput,
  PortfolioScoringSnapshot,
  PortfolioTargetSignal,
  Signal,
  SignalSource,
  SymbolSnapshot,
} from "./llm/types";
import { buildRuleFeatures } from "./scoring/rules";

export type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  PortfolioPositionInput,
  PortfolioScoringSnapshot,
  PortfolioTargetSignal,
  Signal,
  SignalSource,
  SymbolSnapshot,
};

export {
  chat,
  chatDetailed,
  isRetryableTransportError,
  LlmHttpError,
  retryDelayMs,
};

const MIN_SCORABLE_KLINES = 10;
const DEFAULT_SCORE_BATCH_SIZE = 10;
const VALID_ACTIONS = new Set(["buy", "hold", "sell"]);

function envPositiveNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeRationale(value: unknown): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : "LLM未提供理由";
  return text.slice(0, 60);
}

function normalizeShortText(value: unknown, field: string, symbol: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`LLM portfolio signal ${symbol} missing ${field}`);
  }
  return value.trim().slice(0, 80);
}

function normalizeShortTextArray(value: unknown, field: string, symbol: string): string[] {
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

function strictWeight(value: unknown, field: string, symbol: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`LLM portfolio signal ${symbol} invalid ${field}: ${String(value)}`);
  }
  return Number(value.toFixed(6));
}

function strictSignalField(value: unknown, field: string, symbol: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`LLM signal ${symbol} invalid ${field}: ${String(value)}`);
  }
  return Number(value.toFixed(3));
}

function chunks<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) out.push(items.slice(i, i + safeSize));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalSource(cacheHit: boolean): SignalSource {
  return cacheHit ? "llm-cache" : "llm-live";
}

function isStrictLlmOutputError(error: unknown): boolean {
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

function strictOutputRepairMessages(messages: ChatMessage[], error: unknown): ChatMessage[] {
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

function normalizeLlmSignals(
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

function normalizePortfolioSignals(
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

async function scoreSymbolsBatchLlm(
  snapshots: SymbolSnapshot[],
  opts: {
    asOf?: string;
    bypassCache?: boolean;
    mode?: "live" | "backtest";
  } = {},
): Promise<Signal[]> {
  if (snapshots.length === 0) return [];
  const userPayload = {
    as_of: opts.asOf ?? new Date().toISOString().slice(0, 10),
    scoring_rule: "40/30/30 三维平衡：基本面(PEG=pe_ttm/profit_yoy_pct,越低越优)40%、主题景气30%、价格动量30%。任一维度强势可作买入触发。",
    symbols: snapshots.map((s) => ({
      symbol: s.symbol,
      name: s.name ?? undefined,
      theme: s.theme,
      // truncate to last 30 closes to keep prompt small while preserving trend
      closes_tail30: s.closes.slice(-30).map((x) => Number(x.toFixed(3))),
      pe_ttm: s.fundamental?.pe_ttm ?? null,
      pb: s.fundamental?.pb ?? null,
      market_cap_yi: s.fundamental?.market_cap ?? null,
      profit_yoy_pct: s.fundamental?.profit_yoy ?? null,
      features: (() => {
        const f = buildRuleFeatures(s);
        return {
          peg: f.peg,
          peg_score: Number(f.pegScore.toFixed(3)),
          momentum_20d_pct: f.momentum20dPct,
          momentum_score: Number(f.momentumScore.toFixed(3)),
          theme_score: Number(f.themeScore.toFixed(3)),
          data_missing_flags: f.dataMissingFlags,
        };
      })(),
    })),
  };

  const messages: ChatMessage[] = [
    { role: "system" as const, content: STRATEGY_SYSTEM },
    { role: "user" as const, content: JSON.stringify(userPayload) },
  ];
  const model = opts.mode === "backtest" ? resolveLlmConfig().backtestModel : resolveLlmConfig().model;
  const timeoutMs = opts.mode === "backtest"
    ? envPositiveNumber("BACKTEST_LLM_TIMEOUT_MS", 300_000)
    : envPositiveNumber("SIGNALS_LLM_TIMEOUT_MS", 900_000);
  let lastError: unknown;
  const configuredAttempts = opts.mode === "backtest"
    ? envPositiveInt("BACKTEST_LLM_MAX_ATTEMPTS", envPositiveInt("LLM_MAX_ATTEMPTS", 1))
    : envPositiveInt("SIGNALS_LLM_MAX_ATTEMPTS", envPositiveInt("LLM_MAX_ATTEMPTS", 1));
  const attempts = opts.bypassCache ? 1 : configuredAttempts;
  let strictRetryUsed = false;
  let attemptMessages = messages;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await chatDetailed(attemptMessages, {
        model,
        responseFormat: "json_object",
        temperature: attempt === 0 ? 0.2 : 0,
        bypassCache: opts.bypassCache || attempt > 0 || attemptMessages !== messages,
        timeoutMs,
      });
      if (!result.content.trim()) {
        throw new Error("LLM returned empty content");
      }
      return normalizeLlmSignals(result.content, snapshots, signalSource(result.cacheHit));
    } catch (e) {
      lastError = e;
      const canUseConfiguredRetry = attempt < attempts - 1;
      const canUseStrictRetry = !opts.bypassCache && !strictRetryUsed && isStrictLlmOutputError(e);
      if (canUseStrictRetry && !canUseConfiguredRetry) {
        strictRetryUsed = true;
      }
      if (canUseConfiguredRetry || canUseStrictRetry) {
        if (isStrictLlmOutputError(e)) {
          attemptMessages = strictOutputRepairMessages(messages, e);
        }
        await sleep(500 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function scorePortfolioTargetsBatchLlm(
  snapshots: PortfolioScoringSnapshot[],
  opts: {
    asOf?: string;
    bypassCache?: boolean;
  } = {},
): Promise<PortfolioTargetSignal[]> {
  if (snapshots.length === 0) return [];
  const userPayload = {
    as_of: opts.asOf ?? new Date().toISOString().slice(0, 10),
    objective: "未来5-20个交易日目标仓位。输出是人工复核用的持仓建议，不是自动交易指令。",
    symbols: snapshots.map((s) => {
      const features = buildRuleFeatures(s);
      return {
        symbol: s.symbol,
        name: s.name ?? undefined,
        theme: s.theme,
        closes_tail30: s.closes.slice(-30).map((x) => Number(x.toFixed(3))),
        pe_ttm: s.fundamental?.pe_ttm ?? null,
        pb: s.fundamental?.pb ?? null,
        market_cap_yi: s.fundamental?.market_cap ?? null,
        profit_yoy_pct: s.fundamental?.profit_yoy ?? null,
        current_position: s.position
          ? {
              shares: s.position.shares,
              cost_basis: s.position.costBasis,
              current_weight: s.position.currentWeight,
              unrealized_pnl_pct: s.position.unrealizedPnlPct,
            }
          : { shares: 0, current_weight: 0, unrealized_pnl_pct: null },
        features: {
          peg: features.peg,
          peg_score: Number(features.pegScore.toFixed(3)),
          momentum_20d_pct: features.momentum20dPct,
          momentum_score: Number(features.momentumScore.toFixed(3)),
          theme_score: Number(features.themeScore.toFixed(3)),
          data_missing_flags: features.dataMissingFlags,
        },
      };
    }),
  };

  const messages: ChatMessage[] = [
    { role: "system" as const, content: PORTFOLIO_STRATEGY_SYSTEM },
    { role: "user" as const, content: JSON.stringify(userPayload) },
  ];
  const cfg = resolveLlmConfig();
  const timeoutMs = envPositiveNumber("SIGNALS_LLM_TIMEOUT_MS", 900_000);
  let lastError: unknown;
  const configuredAttempts = envPositiveInt("SIGNALS_LLM_MAX_ATTEMPTS", envPositiveInt("LLM_MAX_ATTEMPTS", 1));
  const attempts = opts.bypassCache ? 1 : configuredAttempts;
  let strictRetryUsed = false;
  let attemptMessages = messages;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await chatDetailed(attemptMessages, {
        model: cfg.model,
        responseFormat: "json_object",
        temperature: attempt === 0 ? 0.2 : 0,
        bypassCache: opts.bypassCache || attempt > 0 || attemptMessages !== messages,
        timeoutMs,
      });
      if (!result.content.trim()) {
        throw new Error("LLM returned empty content");
      }
      return normalizePortfolioSignals(result.content, snapshots, signalSource(result.cacheHit));
    } catch (e) {
      lastError = e;
      const canUseConfiguredRetry = attempt < attempts - 1;
      const canUseStrictRetry = !opts.bypassCache && !strictRetryUsed && isStrictLlmOutputError(e);
      if (canUseStrictRetry && !canUseConfiguredRetry) {
        strictRetryUsed = true;
      }
      if (canUseConfiguredRetry || canUseStrictRetry) {
        if (isStrictLlmOutputError(e)) {
          attemptMessages = strictOutputRepairMessages(messages, e);
        }
        await sleep(500 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

/** Deterministic offline scoring for LLM_PROVIDER=mock (e2e/tests only).
 *  A momentum stand-in exercises the full pipeline without network access.
 *  Opt-in via env; production deployments never set it. */
function mockSignalFor(snapshot: SymbolSnapshot): Signal {
  const first = snapshot.closes[0];
  const last = snapshot.closes[snapshot.closes.length - 1];
  const pct = first > 0 ? (last - first) / first : 0;
  const action = pct > 0.02 ? "buy" : pct < -0.02 ? "sell" : "hold";
  return {
    symbol: snapshot.symbol,
    action,
    confidence: 0.5,
    size: action === "buy" ? 0.5 : 0,
    rationale: `mock momentum ${(pct * 100).toFixed(1)}%`,
    source: "llm-mock",
  };
}

function mockPortfolioTargetFor(snapshot: PortfolioScoringSnapshot): PortfolioTargetSignal {
  const sig = mockSignalFor(snapshot);
  return {
    symbol: sig.symbol,
    targetWeight: sig.action === "buy" ? 0.15 : 0,
    confidence: sig.confidence,
    rationale: sig.rationale,
    evidence: ["mock provider：基于窗口动量的占位证据，非真实研究，不可用于实盘决策"],
    risks: ["mock provider：仅供测试/e2e，输出不可当作研究结论或交易依据"],
    invalidation: "mock provider",
    source: "llm-mock",
  };
}

function mockProviderActive(): boolean {
  if (resolveLlmConfig().provider !== "mock") return false;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_LLM !== "1") {
    throw new Error(
      "LLM_PROVIDER=mock is blocked in production; set ALLOW_MOCK_LLM=1 to override (test/e2e only)",
    );
  }
  console.warn("[llm] LLM_PROVIDER=mock: deterministic offline signals (test/e2e only)");
  return true;
}

export async function scorePortfolioTargets(
  snapshots: PortfolioScoringSnapshot[],
  opts: {
    asOf?: string;
    bypassCache?: boolean;
    batchSize?: number;
    onBatchProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PortfolioTargetSignal[]> {
  if (snapshots.length === 0) return [];

  const unscorable = snapshots.filter((s) => s.closes.length < MIN_SCORABLE_KLINES);
  if (unscorable.length > 0) {
    throw new Error(
      `insufficient live kline data for portfolio scoring: ${unscorable.map((s) => s.symbol).join(",")}`,
    );
  }

  const seen = new Set<string>();
  const duplicateInput = snapshots
    .map((s) => s.symbol)
    .filter((symbol) => {
      if (seen.has(symbol)) return true;
      seen.add(symbol);
      return false;
    });
  if (duplicateInput.length > 0) {
    throw new Error(`duplicate input symbols for portfolio scoring: ${duplicateInput.join(",")}`);
  }

  const batchSize = opts.batchSize ?? Number(process.env.LLM_SCORE_BATCH_SIZE ?? DEFAULT_SCORE_BATCH_SIZE);
  const useMock = mockProviderActive();
  const scored: PortfolioTargetSignal[] = [];
  for (const batch of chunks(snapshots, batchSize)) {
    scored.push(...(useMock ? batch.map(mockPortfolioTargetFor) : await scorePortfolioTargetsBatchLlm(batch, opts)));
    opts.onBatchProgress?.(scored.length, snapshots.length);
  }

  const bySymbol = new Map(scored.map((signal) => [signal.symbol, signal] as const));
  return snapshots.map((snapshot) => bySymbol.get(snapshot.symbol)!);
}

export async function scoreSymbols(
  snapshots: SymbolSnapshot[],
  opts: {
    asOf?: string;
    bypassCache?: boolean;
    mode?: "live" | "backtest";
    batchSize?: number;
    onBatchProgress?: (done: number, total: number) => void;
  } = {},
): Promise<Signal[]> {
  if (snapshots.length === 0) return [];

  const unscorable = snapshots.filter((s) => s.closes.length < MIN_SCORABLE_KLINES);
  if (unscorable.length > 0) {
    throw new Error(
      `insufficient live kline data for LLM scoring: ${unscorable.map((s) => s.symbol).join(",")}`,
    );
  }

  const seen = new Set<string>();
  const duplicateInput = snapshots
    .map((s) => s.symbol)
    .filter((symbol) => {
      if (seen.has(symbol)) return true;
      seen.add(symbol);
      return false;
    });
  if (duplicateInput.length > 0) {
    throw new Error(`duplicate input symbols for LLM scoring: ${duplicateInput.join(",")}`);
  }

  const batchSize = opts.batchSize ?? Number(process.env.LLM_SCORE_BATCH_SIZE ?? DEFAULT_SCORE_BATCH_SIZE);
  const useMock = mockProviderActive();
  const scored: Signal[] = [];
  for (const batch of chunks(snapshots, batchSize)) {
    scored.push(...(useMock ? batch.map(mockSignalFor) : await scoreSymbolsBatchLlm(batch, opts)));
    opts.onBatchProgress?.(scored.length, snapshots.length);
  }

  const bySymbol = new Map(scored.map((signal) => [signal.symbol, signal] as const));
  return snapshots.map((snapshot) => bySymbol.get(snapshot.symbol)!);
}
