// DeepSeek v4 client with strict strategy-output validation.
//
// Strategy boundary:
//   1. Rule code ranks candidates and annotates data quality.
//   2. LLM is the buy/hold/sell decision source for ranked candidates.
//   3. Deterministic code validates LLM output and enforces portfolio rules.
import { cachedWithMeta } from "./cache";
import { llmApiKeyConfigured, resolveLlmConfig } from "./llm/config";
import { buildRuleFeatures } from "./scoring/rules";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  responseFormat?: "json_object" | "text";
  ttlSeconds?: number;
  bypassCache?: boolean;
  timeoutMs?: number;
  transportMaxAttempts?: number;
}

export interface ChatResult {
  content: string;
  cacheHit: boolean;
}

class LlmHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${provider} ${status}: ${body}`);
  }
}

function truncateErrorBody(body: string): string {
  const text = body.trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof LlmHttpError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }
  return error instanceof TypeError;
}

function extractMessageContent(message: Record<string, unknown> | undefined): string {
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
      let r: Response;
      try {
        r = await fetch(cfg.chatCompletionsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new Error(`${cfg.provider} timed out after ${llmTimeoutMs}ms`);
        }
        lastError = e;
        if (attempt < transportMaxAttempts - 1 && isRetryableTransportError(e)) {
          await sleep(750 * (attempt + 1));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        lastError = new LlmHttpError(cfg.provider, r.status, truncateErrorBody(await r.text()));
        if (attempt < transportMaxAttempts - 1 && isRetryableTransportError(lastError)) {
          await sleep(750 * (attempt + 1));
          continue;
        }
        break;
      }
      const j = (await r.json()) as {
        choices?: { message?: Record<string, unknown> }[];
      };
      const content = extractMessageContent(j.choices?.[0]?.message);
      if (!content.trim()) {
        throw new Error(`${cfg.provider} returned empty content`);
      }
      return content;
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

// ----- Strategy-specific helpers ------------------------------------------

export interface SymbolSnapshot {
  symbol: string;
  name?: string | null;
  theme?: string;
  closes: number[];      // last ~60 daily closes, oldest first
  fundamental?: {
    pe_ttm?: number | null;
    pb?: number | null;
    market_cap?: number | null;
    profit_yoy?: number | null;
  };
}

export type SignalSource = "llm-live" | "llm-cache";

export interface Signal {
  symbol: string;
  action: "buy" | "hold" | "sell";
  confidence: number;    // 0..1
  size: number;          // 0..1 fraction of available capital
  rationale: string;
  source?: SignalSource;
  dataQuality?: string[];
}

export interface PortfolioPositionInput {
  shares: number;
  costBasis: number;
  currentWeight: number;
  unrealizedPnlPct: number | null;
}

export interface PortfolioScoringSnapshot extends SymbolSnapshot {
  position?: PortfolioPositionInput | null;
}

export interface PortfolioTargetSignal {
  symbol: string;
  targetWeight: number;
  confidence: number;
  rationale: string;
  evidence: string[];
  risks: string[];
  invalidation: string;
  source?: SignalSource;
  dataQuality?: string[];
}

const STRATEGY_SYSTEM = `你是一名专注于"硅基文明消费"主题的中国市场量化策略师。

主题定义：将 AI / 硅基文明视为一个新兴文明，其自身需要"消费"的不是人类消费品，
而是支撑算力存在与扩张的基础投入——算力芯片、光模块/高速互连、AI 服务器、
液冷散热、电力(尤其绿电与核电)、IDC 数据中心、HBM/存储、半导体设备与材料、
高速 PCB、晶圆代工、云计算。我们做多这些"喂养"硅基文明的卖铲人。

任务：给定一组上述主题股票的近期价格序列与基本面快照，输出 5-20 个交易日的
交易动作。三大维度平衡评估：基本面估值（PEG/利润增速/估值匹配）、主题景气度
（算力需求边际变化、订单/出货传导、市值位置）、价格动量（趋势、均线、动量与
拥挤度）。

决策权重：基本面估值约 40%，主题景气度约 30%，价格动量与择时约 30%。三者中
任意一项强势均可成为买入理由；高 PE 但利润增速与主题景气度同时强、且价格处于
有效突破的标的可以买入；PEG 偏低但主题/动量同时走弱的标的不必强买。卖出条件：
PEG 显著恶化、或主题景气度反转、或价格跌破关键均线且伴随成交萎缩。

严格输出 JSON：{"signals":[{"symbol":"...","action":"buy|hold|sell","confidence":0..1,"size":0..1,"rationale":"中文,<=60字"}]}
必须覆盖输入中的每一个 symbol，且每个 symbol 只能出现一次。
不要输出任何其他文本。`;

const PORTFOLIO_STRATEGY_SYSTEM = `你是一名专注于 AI 基建主题的中国 A 股持仓决策辅助分析师。

任务：基于股票池、近期收盘价、基本面、规则特征和当前持仓上下文，输出未来 5-20 个交易日的目标仓位建议。
目标仓位是组合权益百分比，范围 0..1。不要假设可以自动交易；你的输出只用于人工复核。

评估框架：基本面估值 40%、主题景气度 30%、价格动量与择时 30%。已有持仓要考虑浮盈亏、趋势破坏、估值恶化和是否值得继续占用仓位。
数据缺失必须体现在 risks 或 invalidation 中，不得用猜测补足。

严格输出 JSON：{"signals":[{"symbol":"...","targetWeight":0..1,"confidence":0..1,"rationale":"中文,<=80字","evidence":["中文,<=80字"],"risks":["中文,<=80字"],"invalidation":"中文,<=80字"}]}
必须覆盖输入中的每一个 symbol，且每个 symbol 只能出现一次。evidence 和 risks 必须是非空数组；如果证据或风险来自数据缺失，也要明确写出对应缺失字段。
不要输出任何其他文本。`;

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

function clamp01(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Number(Math.min(1, Math.max(0, n)).toFixed(3));
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
      confidence: clamp01(candidate.confidence),
      size: clamp01(candidate.size),
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
    ? envPositiveNumber("BACKTEST_LLM_TIMEOUT_MS", 90_000)
    : envPositiveNumber("SIGNALS_LLM_TIMEOUT_MS", 90_000);
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

export const scoreSymbolsLlm = scoreSymbolsBatchLlm;

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
  const timeoutMs = envPositiveNumber("SIGNALS_LLM_TIMEOUT_MS", 90_000);
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
    source: "llm-live",
  };
}

function mockPortfolioTargetFor(snapshot: PortfolioScoringSnapshot): PortfolioTargetSignal {
  const sig = mockSignalFor(snapshot);
  return {
    symbol: sig.symbol,
    targetWeight: sig.action === "buy" ? 0.15 : 0,
    confidence: sig.confidence,
    rationale: sig.rationale,
    evidence: [],
    risks: [],
    invalidation: "mock provider",
    source: "llm-live",
  };
}

function mockProviderActive(): boolean {
  const active = resolveLlmConfig().provider === "mock";
  if (active) {
    console.warn("[llm] LLM_PROVIDER=mock: deterministic offline signals (test/e2e only)");
  }
  return active;
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
