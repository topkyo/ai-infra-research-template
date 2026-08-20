import { resolveLlmConfig } from "./config";
import { mockProviderActive, mockSignalFor } from "./mock";
import { strategySystem, strategySystemBacktest } from "./prompts";
import { chatWithScoreRetry } from "./score-retry";
import {
  chunks,
  DEFAULT_SCORE_BATCH_SIZE,
  envPositiveInt,
  envPositiveNumber,
  MIN_SCORABLE_KLINES,
  normalizeLlmSignals,
  signalSource,
} from "./strict";
import type { ChatMessage, Signal, SymbolSnapshot } from "./types";
import { buildRuleFeatures } from "../scoring/rules";

const LIVE_SCORING_RULE =
  "40/30/30 三维平衡：基本面(PEG=pe_ttm/profit_yoy_pct,越低越优)40%、主题景气30%、价格动量30%。任一维度强势可作买入触发。";
const BACKTEST_SCORING_RULE =
  "50/50 二维平衡：主题景气50%、价格动量50%。回测不含基本面/PEG（无 point-in-time 历史基本面，避免 look-ahead）。";

const BACKTEST_OMIT_MISSING_FLAGS = new Set([
  "missing_fundamental",
  "missing_pe_ttm",
  "missing_profit_yoy",
  "missing_pb",
  "missing_market_cap",
  "missing_peg",
]);

function buildLiveSymbolPayload(s: SymbolSnapshot) {
  const f = buildRuleFeatures(s);
  return {
    symbol: s.symbol,
    name: s.name ?? undefined,
    theme: s.theme,
    closes_tail30: s.closes.slice(-30).map((x) => Number(x.toFixed(3))),
    pe_ttm: s.fundamental?.pe_ttm ?? null,
    pb: s.fundamental?.pb ?? null,
    market_cap_yi: s.fundamental?.market_cap ?? null,
    profit_yoy_pct: s.fundamental?.profit_yoy ?? null,
    features: {
      peg: f.peg,
      peg_score: Number(f.pegScore.toFixed(3)),
      momentum_20d_pct: f.momentum20dPct,
      momentum_score: Number(f.momentumScore.toFixed(3)),
      theme_score: Number(f.themeScore.toFixed(3)),
      data_missing_flags: f.dataMissingFlags,
    },
  };
}

function buildBacktestSymbolPayload(s: SymbolSnapshot) {
  const f = buildRuleFeatures(s);
  return {
    symbol: s.symbol,
    name: s.name ?? undefined,
    theme: s.theme,
    closes_tail30: s.closes.slice(-30).map((x) => Number(x.toFixed(3))),
    features: {
      momentum_20d_pct: f.momentum20dPct,
      momentum_score: Number(f.momentumScore.toFixed(3)),
      theme_score: Number(f.themeScore.toFixed(3)),
      data_missing_flags: f.dataMissingFlags.filter((flag) => !BACKTEST_OMIT_MISSING_FLAGS.has(flag)),
    },
  };
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
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const isBacktest = opts.mode === "backtest";
  const userPayload = isBacktest
    ? {
        as_of: asOf,
        scoring_rule: BACKTEST_SCORING_RULE,
        symbols: snapshots.map(buildBacktestSymbolPayload),
      }
    : {
        as_of: asOf,
        scoring_rule: LIVE_SCORING_RULE,
        symbols: snapshots.map(buildLiveSymbolPayload),
      };

  const messages: ChatMessage[] = [
    { role: "system" as const, content: isBacktest ? strategySystemBacktest() : strategySystem() },
    { role: "user" as const, content: JSON.stringify(userPayload) },
  ];
  const model = opts.mode === "backtest" ? resolveLlmConfig().backtestModel : resolveLlmConfig().model;
  const timeoutMs = opts.mode === "backtest"
    ? envPositiveNumber("BACKTEST_LLM_TIMEOUT_MS", 300_000)
    : envPositiveNumber("SIGNALS_LLM_TIMEOUT_MS", 900_000);
  const configuredAttempts = opts.mode === "backtest"
    ? envPositiveInt("BACKTEST_LLM_MAX_ATTEMPTS", envPositiveInt("LLM_MAX_ATTEMPTS", 1))
    : envPositiveInt("SIGNALS_LLM_MAX_ATTEMPTS", envPositiveInt("LLM_MAX_ATTEMPTS", 1));
  return chatWithScoreRetry(
    { messages, model, timeoutMs, configuredAttempts, bypassCache: opts.bypassCache },
    (content, cacheHit) => normalizeLlmSignals(content, snapshots, signalSource(cacheHit)),
  );
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
