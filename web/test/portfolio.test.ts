import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolioContext,
  buildPortfolioRows,
  type PortfolioContext,
  type PositionSnapshot,
} from "../lib/portfolio";
import type { PortfolioTargetSignal, SymbolSnapshot } from "../lib/deepseek";
import type { UniverseEntry } from "../lib/universe";

const entries: UniverseEntry[] = [
  { symbol: "A", name: "A", theme: "T" },
  { symbol: "B", name: "B", theme: "T" },
  { symbol: "C", name: "C", theme: "T" },
];

const snapshots: SymbolSnapshot[] = entries.map((entry, index) => ({
  symbol: entry.symbol,
  name: entry.name,
  theme: entry.theme,
  closes: [100 + index],
}));

function target(symbol: string, targetWeight: number, confidence = 1): PortfolioTargetSignal {
  return {
    symbol,
    targetWeight,
    confidence,
    rationale: "ok",
    evidence: ["e"],
    risks: ["r"],
    invalidation: "i",
    source: "llm-live",
  };
}

test("buildPortfolioContext calculates current weights and unrealized PnL", () => {
  const { portfolio, positions } = buildPortfolioContext({
    fileFound: true,
    filePath: "x",
    cash: 1000,
    positions: [{ symbol: "A", shares: 10, cost_basis: 80 }],
    warnings: [],
  }, snapshots, "2026-05-31", 6);

  assert.equal(portfolio.equity, 2000);
  assert.equal(positions.get("A")?.currentValue, 1000);
  assert.equal(positions.get("A")?.currentWeight, 0.5);
  assert.equal(positions.get("A")?.unrealizedPnlPct, 25);
});

test("buildPortfolioRows enforces max positions and normalizes total target weight", () => {
  const portfolio: PortfolioContext = {
    mode: "real",
    cash: 0,
    equity: 100000,
    maxPositions: 2,
    asOf: "2026-05-31",
    holdingsFileFound: true,
    warnings: [],
  };
  const positions = new Map<string, PositionSnapshot>();
  const rows = buildPortfolioRows(entries, snapshots, [
    target("A", 0.8, 1),
    target("B", 0.8, 0.9),
    target("C", 0.8, 0.8),
  ], positions, portfolio);

  assert.equal(rows.find((row) => row.entry.symbol === "A")?.recommendation.adjustedTargetWeight, 0.5);
  assert.equal(rows.find((row) => row.entry.symbol === "B")?.recommendation.adjustedTargetWeight, 0.5);
  assert.equal(rows.find((row) => row.entry.symbol === "C")?.recommendation.adjustedTargetWeight, 0);
  assert.match(rows.find((row) => row.entry.symbol === "C")?.recommendation.constraintWarnings[0] ?? "", /maxPositions/);
});

test("buildPortfolioRows derives portfolio actions from current and target weights", () => {
  const portfolio: PortfolioContext = {
    mode: "real",
    cash: 0,
    equity: 100000,
    maxPositions: 6,
    asOf: "2026-05-31",
    holdingsFileFound: true,
    warnings: [],
  };
  const positions = new Map<string, PositionSnapshot>([
    ["A", {
      symbol: "A",
      shares: 100,
      costBasis: 100,
      currentPrice: 100,
      currentValue: 10000,
      currentWeight: 0.1,
      unrealizedPnlPct: 0,
    }],
  ]);
  const rows = buildPortfolioRows(entries, snapshots, [
    target("A", 0.2),
    target("B", 0.1),
    target("C", 0),
  ], positions, portfolio);

  assert.equal(rows.find((row) => row.entry.symbol === "A")?.recommendation.action, "add");
  assert.equal(rows.find((row) => row.entry.symbol === "B")?.recommendation.action, "open");
  assert.equal(rows.find((row) => row.entry.symbol === "C")?.recommendation.action, "watch");
});
