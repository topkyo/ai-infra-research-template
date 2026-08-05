import { resolveLlmConfig } from "./config";
import { mockProviderActive, mockSignalFor } from "./mock";
import { STRATEGY_SYSTEM } from "./prompts";
import {
  chunks,
  DEFAULT_SCORE_BATCH_SIZE,
  envPositiveInt,
  envPositiveNumber,
  isStrictLlmOutputError,
  MIN_SCORABLE_KLINES,
  normalizeLlmSignals,
  signalSource,
  sleep,
  strictOutputRepairMessages,
} from "./strict";
import { chatDetailed } from "./transport";
import type { ChatMessage, Signal, SymbolSnapshot } from "./types";
import { buildRuleFeatures } from "../scoring/rules";

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
