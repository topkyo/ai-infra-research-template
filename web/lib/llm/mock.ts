import { resolveLlmConfig } from "./config";
import type { PortfolioScoringSnapshot, PortfolioTargetSignal, Signal, SymbolSnapshot } from "./types";

/** Deterministic offline scoring for LLM_PROVIDER=mock (e2e/tests only).
 *  A momentum stand-in exercises the full pipeline without network access.
 *  Opt-in via env; production deployments never set it. */
export function mockSignalFor(snapshot: SymbolSnapshot): Signal {
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

export function mockPortfolioTargetFor(snapshot: PortfolioScoringSnapshot): PortfolioTargetSignal {
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

export function mockProviderActive(): boolean {
  if (resolveLlmConfig().provider !== "mock") return false;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_LLM !== "1") {
    throw new Error(
      "LLM_PROVIDER=mock is blocked in production; set ALLOW_MOCK_LLM=1 to override (test/e2e only)",
    );
  }
  console.warn("[llm] LLM_PROVIDER=mock: deterministic offline signals (test/e2e only)");
  return true;
}
