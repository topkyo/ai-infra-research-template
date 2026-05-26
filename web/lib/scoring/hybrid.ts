import type { Signal, SymbolSnapshot } from "../deepseek";
import { scoreSymbolsLlm } from "../deepseek";
import { llmApiKeyConfigured } from "../llm/config";
import { rankByRules, rulesToSignals } from "./rules";

const TOP_K = Number(process.env.HYBRID_LLM_TOP_K ?? 20);

/** Rule pre-screen + LLM final call for top-K symbols (token-efficient). */
export async function scoreSymbolsHybrid(
  snapshots: SymbolSnapshot[],
  opts: { asOf?: string; bypassCache?: boolean; mode?: "live" | "backtest" } = {},
): Promise<Signal[]> {
  if (snapshots.length === 0) return [];

  const ranked = rankByRules(snapshots);
  if (!llmApiKeyConfigured()) {
    return rulesToSignals(ranked);
  }

  const topSymbols = new Set(ranked.slice(0, TOP_K).map((r) => r.symbol));
  const forLlm = snapshots.filter((s) => topSymbols.has(s.symbol));
  const rest = snapshots.filter((s) => !topSymbols.has(s.symbol));

  const llmSignals = await scoreSymbolsLlm(forLlm, opts);
  const llmBySymbol = new Map(llmSignals.map((s) => [s.symbol, s]));

  const restSignals: Signal[] = rest.map((s) => {
    const rule = ranked.find((r) => r.symbol === s.symbol)!;
    return {
      symbol: s.symbol,
      action: "hold",
      confidence: Number(Math.min(0.55, rule.score).toFixed(3)),
      size: 0,
      rationale: `预筛未进Top${TOP_K}:${rule.rationale}`.slice(0, 60),
    };
  });

  const merged = [...llmSignals];
  for (const sym of topSymbols) {
    if (!llmBySymbol.has(sym)) {
      const rule = ranked.find((r) => r.symbol === sym)!;
      merged.push({
        symbol: sym,
        action: rule.suggestedAction,
        confidence: Number(rule.score.toFixed(3)),
        size: rule.suggestedAction === "buy" ? Number(rule.score.toFixed(3)) : 0,
        rationale: `LLM未返回,规则兜底:${rule.rationale}`.slice(0, 60),
      });
    }
  }

  return [...merged, ...restSignals];
}
