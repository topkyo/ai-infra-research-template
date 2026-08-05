import { resolveLlmConfig } from "./config";
import { mockPortfolioTargetFor, mockProviderActive } from "./mock";
import { PORTFOLIO_STRATEGY_SYSTEM } from "./prompts";
import {
  chunks,
  DEFAULT_SCORE_BATCH_SIZE,
  envPositiveInt,
  envPositiveNumber,
  isStrictLlmOutputError,
  MIN_SCORABLE_KLINES,
  normalizePortfolioSignals,
  signalSource,
  sleep,
  strictOutputRepairMessages,
} from "./strict";
import { chatDetailed } from "./transport";
import type { ChatMessage, PortfolioScoringSnapshot, PortfolioTargetSignal } from "./types";
import { buildRuleFeatures } from "../scoring/rules";

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
