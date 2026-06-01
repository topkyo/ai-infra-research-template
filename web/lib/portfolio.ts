import type { SignalSource, SymbolSnapshot, PortfolioTargetSignal } from "./deepseek";
import type { LoadedHoldings } from "./holdings";
import type { UniverseEntry } from "./universe";

export const DEFAULT_MAX_POSITIONS = 6;
const ACTION_EPSILON = 0.005;

export type PortfolioAction = "open" | "add" | "hold" | "trim" | "exit" | "watch";

export interface PositionSnapshot {
  symbol: string;
  shares: number;
  costBasis: number;
  currentPrice: number;
  currentValue: number;
  currentWeight: number;
  unrealizedPnlPct: number | null;
}

export interface PortfolioContext {
  mode: "real" | "paper";
  cash: number;
  equity: number;
  maxPositions: number;
  asOf: string;
  holdingsUpdatedAt?: string;
  holdingsFileFound: boolean;
  warnings: string[];
}

export interface PortfolioRecommendation {
  action: PortfolioAction;
  targetWeight: number;
  adjustedTargetWeight: number;
  deltaWeight: number;
  targetValue: number;
  deltaValue: number;
  confidence: number;
  rationale: string;
  evidence: string[];
  risks: string[];
  invalidation: string;
  source?: SignalSource;
  dataQuality?: string[];
  constraintWarnings: string[];
}

export interface PortfolioSignalRow {
  entry: UniverseEntry;
  snapshot: SymbolSnapshot & {
    dataErrors?: string[];
    fundamentalSource?: string | null;
    fundamentalFieldSources?: Record<string, string> | null;
  };
  position: PositionSnapshot | null;
  recommendation: PortfolioRecommendation;
}

export function buildPortfolioContext(
  holdings: LoadedHoldings,
  snapshots: SymbolSnapshot[],
  asOf: string,
  maxPositions = DEFAULT_MAX_POSITIONS,
  mode: PortfolioContext["mode"] = "real",
): { portfolio: PortfolioContext; positions: Map<string, PositionSnapshot> } {
  const latestBySymbol = new Map(
    snapshots.map((snapshot) => [snapshot.symbol, snapshot.closes.at(-1)] as const),
  );
  const positions = new Map<string, PositionSnapshot>();
  let positionValue = 0;
  for (const holding of holdings.positions) {
    const currentPrice = latestBySymbol.get(holding.symbol);
    if (currentPrice == null || currentPrice <= 0) {
      throw new Error(`missing current price for held position ${holding.symbol}`);
    }
    const currentValue = holding.shares * currentPrice;
    positionValue += currentValue;
    positions.set(holding.symbol, {
      symbol: holding.symbol,
      shares: holding.shares,
      costBasis: holding.cost_basis,
      currentPrice,
      currentValue,
      currentWeight: 0,
      unrealizedPnlPct: holding.cost_basis > 0
        ? Number(((currentPrice / holding.cost_basis - 1) * 100).toFixed(3))
        : null,
    });
  }

  const equity = holdings.cash + positionValue;
  for (const position of positions.values()) {
    position.currentWeight = equity > 0
      ? Number((position.currentValue / equity).toFixed(6))
      : 0;
  }

  const warnings = [...holdings.warnings];
  if (equity <= 0) {
    warnings.push("portfolio equity is zero; target values and delta values are informational only");
  }

  return {
    portfolio: {
      mode,
      cash: holdings.cash,
      equity,
      maxPositions,
      asOf,
      holdingsUpdatedAt: holdings.updated_at,
      holdingsFileFound: holdings.fileFound,
      warnings,
    },
    positions,
  };
}

function inferAction(currentWeight: number, adjustedTargetWeight: number): PortfolioAction {
  const delta = adjustedTargetWeight - currentWeight;
  if (currentWeight <= ACTION_EPSILON && adjustedTargetWeight <= ACTION_EPSILON) return "watch";
  if (currentWeight <= ACTION_EPSILON && adjustedTargetWeight > ACTION_EPSILON) return "open";
  if (currentWeight > ACTION_EPSILON && adjustedTargetWeight <= ACTION_EPSILON) return "exit";
  if (delta > ACTION_EPSILON) return "add";
  if (delta < -ACTION_EPSILON) return "trim";
  return "hold";
}

export function buildPortfolioRows(
  entries: UniverseEntry[],
  snapshots: Array<PortfolioSignalRow["snapshot"]>,
  targets: PortfolioTargetSignal[],
  positions: Map<string, PositionSnapshot>,
  portfolio: PortfolioContext,
): PortfolioSignalRow[] {
  const targetBySymbol = new Map(targets.map((target) => [target.symbol, target]));
  const nonZero = targets
    .filter((target) => target.targetWeight > 0)
    .sort((a, b) => b.targetWeight * b.confidence - a.targetWeight * a.confidence);
  const kept = new Set(nonZero.slice(0, portfolio.maxPositions).map((target) => target.symbol));
  const dropped = new Set(nonZero.slice(portfolio.maxPositions).map((target) => target.symbol));
  const rawKeptSum = targets.reduce(
    (sum, target) => sum + (kept.has(target.symbol) ? target.targetWeight : 0),
    0,
  );
  const normalizeRatio = rawKeptSum > 1 ? 1 / rawKeptSum : 1;
  const snapshotBySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));

  return entries.map((entry) => {
    const target = targetBySymbol.get(entry.symbol);
    const snapshot = snapshotBySymbol.get(entry.symbol);
    if (!target || !snapshot) {
      throw new Error(`missing portfolio signal row for ${entry.symbol}`);
    }
    const position = positions.get(entry.symbol) ?? null;
    const currentWeight = position?.currentWeight ?? 0;
    const currentValue = position?.currentValue ?? 0;
    const constraintWarnings: string[] = [];
    let adjustedTargetWeight = kept.has(entry.symbol) ? target.targetWeight * normalizeRatio : 0;
    adjustedTargetWeight = Number(adjustedTargetWeight.toFixed(6));
    if (dropped.has(entry.symbol)) {
      constraintWarnings.push(`超过最大持仓数 ${portfolio.maxPositions}，目标仓位已置为 0`);
    }
    if (kept.has(entry.symbol) && normalizeRatio < 1) {
      constraintWarnings.push("组合目标仓位合计超过 100%，已按比例压缩");
    }
    const targetValue = portfolio.equity * adjustedTargetWeight;
    const deltaWeight = Number((adjustedTargetWeight - currentWeight).toFixed(6));
    const deltaValue = targetValue - currentValue;

    return {
      entry,
      snapshot,
      position,
      recommendation: {
        action: inferAction(currentWeight, adjustedTargetWeight),
        targetWeight: target.targetWeight,
        adjustedTargetWeight,
        deltaWeight,
        targetValue,
        deltaValue,
        confidence: target.confidence,
        rationale: target.rationale,
        evidence: target.evidence,
        risks: target.risks,
        invalidation: target.invalidation,
        source: target.source,
        dataQuality: target.dataQuality,
        constraintWarnings,
      },
    };
  });
}
