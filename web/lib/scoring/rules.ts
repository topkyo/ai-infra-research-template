import type { SymbolSnapshot } from "../deepseek";

export interface RuleScore {
  symbol: string;
  score: number;
  pegScore: number;
  momentumScore: number;
  themeScore: number;
  suggestedAction: "buy" | "hold" | "sell";
  rationale: string;
}

const GLOBAL_SUPPLY_THEMES = new Set([
  "光模块",
  "AI服务器",
  "存储/HBM",
  "半导体设备",
  "半导体材料",
  "AI-PCB",
  "晶圆代工",
]);

function calcPeg(pe?: number | null, profitYoyPct?: number | null): number | null {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) {
    return null;
  }
  return pe / profitYoyPct;
}

function pegScore(peg: number | null): number {
  if (peg == null) return 0.45;
  if (peg <= 0.8) return 1;
  if (peg <= 1.2) return 0.85;
  if (peg <= 2) return 0.6;
  if (peg <= 3) return 0.35;
  return 0.15;
}

function momentumScore(closes: number[]): number {
  if (closes.length < 10) return 0.4;
  const tail = closes.slice(-20);
  const start = tail[0];
  const end = tail[tail.length - 1];
  if (start <= 0) return 0.4;
  const ret = end / start - 1;
  if (ret > 0.15) return 1;
  if (ret > 0.05) return 0.75;
  if (ret > -0.05) return 0.5;
  if (ret > -0.15) return 0.25;
  return 0.1;
}

function themeScore(theme?: string): number {
  if (!theme) return 0.5;
  if (GLOBAL_SUPPLY_THEMES.has(theme)) return 0.85;
  if (theme.includes("算力") || theme.includes("IDC") || theme.includes("液冷")) {
    return 0.75;
  }
  return 0.55;
}

export function scoreWithRules(snapshot: SymbolSnapshot): RuleScore {
  const peg = calcPeg(snapshot.fundamental?.pe_ttm, snapshot.fundamental?.profit_yoy);
  const pScore = pegScore(peg);
  const mScore = momentumScore(snapshot.closes);
  const tScore = themeScore(snapshot.theme);
  const score = pScore * 0.4 + tScore * 0.3 + mScore * 0.3;

  let suggestedAction: RuleScore["suggestedAction"] = "hold";
  if (score >= 0.72 && mScore >= 0.5) suggestedAction = "buy";
  else if (score <= 0.35 || mScore <= 0.2) suggestedAction = "sell";

  const pegText = peg != null ? `PEG${peg.toFixed(2)}` : "PEG缺失";
  const rationale = `规则:${pegText} 动量${(mScore * 100).toFixed(0)} 主题${(tScore * 100).toFixed(0)}`;

  return {
    symbol: snapshot.symbol,
    score,
    pegScore: pScore,
    momentumScore: mScore,
    themeScore: tScore,
    suggestedAction,
    rationale,
  };
}

export function rankByRules(snapshots: SymbolSnapshot[]): RuleScore[] {
  return snapshots.map(scoreWithRules).sort((a, b) => b.score - a.score);
}

export function rulesToSignals(ranked: RuleScore[]): import("../deepseek").Signal[] {
  return ranked.map((r) => ({
    symbol: r.symbol,
    action: r.suggestedAction,
    confidence: Number(Math.min(1, Math.max(0.2, r.score)).toFixed(3)),
    size: r.suggestedAction === "buy" ? Number(Math.min(1, r.score).toFixed(3)) : 0,
    rationale: r.rationale.slice(0, 60),
  }));
}
