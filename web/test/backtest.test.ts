// Real backtest exercise with deterministic injected scorer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Cache backend writes under cwd/.cache; sandbox it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-bt-"));
process.chdir(tmp);

import type { Kline } from "../lib/pyserver";
import { runBacktest, type SymbolSeries, type Progress, type BacktestConfig, type Scorer } from "../lib/backtest";

// Deterministic scorer: always BUY A, SELL B with full size.
const scorer: Scorer = async (snapshots) =>
  snapshots.map((s) => ({
    symbol: s.symbol,
    action: s.symbol === "A" ? "buy" : "sell",
    confidence: 1,
    size: s.symbol === "A" ? 1 : 0,
    rationale: "test",
  }));

function makeKlines(start: string, closes: number[]): Kline[] {
  const d = new Date(start);
  return closes.map((c) => {
    // Skip weekends to mimic trading days.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date, open: c, high: c, low: c, close: c, volume: 1_000_000 };
  });
}

function makeSeries(): SymbolSeries[] {
  // A trends up (100→150), B trends down (100→70).
  const aCloses = Array.from({ length: 80 }, (_, i) => 100 + i * 0.625);
  const bCloses = Array.from({ length: 80 }, (_, i) => 100 - i * 0.375);
  return [
    { entry: { symbol: "A", name: "Up", theme: "T" }, klines: makeKlines("2025-01-01", aCloses) },
    { entry: { symbol: "B", name: "Down", theme: "T" }, klines: makeKlines("2025-01-01", bCloses) },
  ];
}

const cfg: BacktestConfig = {
  startCash: 1_000_000,
  rebalanceEveryNDays: 5,
  // dates from makeSeries start at 2025-01-01 (UTC); first business day is 01-01.
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  feeBps: 0,
  maxPositions: 5,
};

test("runBacktest produces a result with expected shape", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  assert.ok(r.equityCurve.length > 30);
  assert.ok(r.trades.length > 0);
  assert.ok(typeof r.stats.totalReturnPct === "number");
  assert.ok(typeof r.stats.maxDrawdownPct === "number");
});

test("backtest buys the up-trending symbol", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  const buys = r.trades.filter((t) => t.side === "buy");
  assert.ok(buys.length > 0, "expected at least one buy");
  assert.ok(buys.every((t) => t.symbol === "A"), "should only buy A (up trender)");
});

test("equity is monotonically tracking the chosen asset (no losses on uptrend)", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  const start = r.equityCurve[0].equity;
  const end = r.equityCurve.at(-1)!.equity;
  assert.ok(end > start, `expected end (${end}) > start (${start}) when buying uptrend`);
  // Total return should be positive and substantial — A goes 100→150 = +50%, we
  // capture most of it after the first rebalance lag.
  assert.ok(r.stats.totalReturnPct > 20, `got ${r.stats.totalReturnPct}%`);
});

test("progress callback fires for signals + simulating phases", async () => {
  const events: Progress[] = [];
  await runBacktest(makeSeries(), cfg, { scorer, onProgress: (p) => events.push(p) });
  const phases = new Set(events.map((e) => e.phase));
  assert.ok(phases.has("signals"), "expected signals events");
  assert.ok(phases.has("simulating"), "expected simulating events");
  // First and last simulating events should bracket [0, N].
  const sim = events.filter((e) => e.phase === "simulating");
  assert.equal(sim[0].done, 0);
  assert.equal(sim.at(-1)!.done, sim.at(-1)!.total);
});

test("runBacktest propagates scorer failures instead of fabricating hold signals", async () => {
  const failingScorer: Scorer = async () => {
    throw new Error("opencode-go timed out after 120000ms");
  };
  await assert.rejects(() => runBacktest(makeSeries(), cfg, {
    scorer: failingScorer,
  }), /opencode-go timed out/);
});

test("throws when window has too few aligned trading days", async () => {
  const tinyCfg = { ...cfg, startDate: "2025-12-29", endDate: "2025-12-31" };
  await assert.rejects(() => runBacktest(makeSeries(), tinyCfg, { scorer }), /aligned/i);
});


test("runBacktest attaches benchmark curve when provided", async () => {
  const benchCloses = Array.from({ length: 80 }, (_, i) => 3000 + i * 2);
  const benchKlines = makeKlines("2025-01-01", benchCloses);
  const r = await runBacktest(makeSeries(), cfg, {
    scorer,
    benchmark: { id: "csi300", name: "沪深300", klines: benchKlines },
  });
  assert.ok(r.benchmark);
  assert.equal(r.benchmark!.equityCurve.length, r.equityCurve.length);
  assert.ok(typeof r.stats.excessReturnPct === "number");
});

test("delta rebalance sells stale holdings before buying the new top signal", async () => {
  const rotatingScorer: Scorer = async (snapshots, opts) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? "buy" : "hold",
      confidence: 1,
      size: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? 1 : 0,
      rationale: "rotate",
    }));
  const r = await runBacktest(makeSeries(), cfg, { scorer: rotatingScorer });
  const jan8Trades = r.trades.filter((t) => t.date === "2025-01-08");
  assert.ok(jan8Trades.some((t) => t.side === "sell" && t.symbol === "A"), "expected A to be sold");
  assert.ok(jan8Trades.some((t) => t.side === "buy" && t.symbol === "B"), "expected B to be bought");
});

test("rebalance keeps maxPositions as a hard cap", async () => {
  const manySeries: SymbolSeries[] = ["A", "B", "C"].map((symbol, offset) => ({
    entry: { symbol, name: symbol, theme: "T" },
    klines: makeKlines("2025-01-01", Array.from({ length: 80 }, (_, i) => 100 + i + offset)),
  }));
  const allBuyScorer: Scorer = async (snapshots) =>
    snapshots.map((s, i) => ({
      symbol: s.symbol,
      action: "buy",
      confidence: 1 - i * 0.1,
      size: 1,
      rationale: "buy",
    }));
  const r = await runBacktest(
    manySeries,
    { ...cfg, maxPositions: 1 },
    { scorer: allBuyScorer },
  );
  assert.ok(
    r.equityCurve.every((bar) => Object.keys(bar.positions).length <= 1),
    "expected no bar to exceed maxPositions",
  );
});

test("feeBps is applied as a one-way trading fee on buys", async () => {
  const flatSeries: SymbolSeries[] = [
    {
      entry: { symbol: "A", name: "Flat", theme: "T" },
      klines: makeKlines("2025-01-01", Array.from({ length: 10 }, () => 100)),
    },
  ];
  const buyScorer: Scorer = async (snapshots) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: "buy",
      confidence: 1,
      size: 1,
      rationale: "buy",
    }));
  const r = await runBacktest(
    flatSeries,
    { ...cfg, rebalanceEveryNDays: 100, feeBps: 100 },
    { scorer: buyScorer },
  );
  assert.equal(r.equityCurve[0].positions.A.shares, 9900);
  assert.equal(r.equityCurve[0].cash, 100);
});

test("slippageBps worsens execution prices on buys", async () => {
  const flatSeries: SymbolSeries[] = [
    {
      entry: { symbol: "A", name: "Flat", theme: "T" },
      klines: makeKlines("2025-01-01", Array.from({ length: 10 }, () => 100)),
    },
  ];
  const buyScorer: Scorer = async (snapshots) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: "buy",
      confidence: 1,
      size: 1,
      rationale: "buy",
    }));
  const r = await runBacktest(
    flatSeries,
    { ...cfg, rebalanceEveryNDays: 100, feeBps: 0, slippageBps: 10 },
    { scorer: buyScorer },
  );
  const buy = r.trades.find((t) => t.side === "buy")!;
  assert.equal(buy.price, 100.1); // 100 * (1 + 10bps)
  assert.equal(buy.shares, 9900); // floor(1_000_000 / 100.1 / 100) * 100
  assert.equal(r.equityCurve[0].cash, 9010);
});

test("slippageBps worsens execution prices on sells", async () => {
  const flatSeries: SymbolSeries[] = [
    { entry: { symbol: "A", name: "Flat", theme: "T" }, klines: makeKlines("2025-01-01", Array.from({ length: 10 }, () => 100)) },
    { entry: { symbol: "B", name: "Flat2", theme: "T" }, klines: makeKlines("2025-01-01", Array.from({ length: 10 }, () => 100)) },
  ];
  // Buy A on day 0, rotate to B on the next rebalance day -> A is sold.
  const rotScorer: Scorer = async (snapshots, opts) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? "buy" : "hold",
      confidence: 1,
      size: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? 1 : 0,
      rationale: "rotate",
    }));
  const r = await runBacktest(
    flatSeries,
    { ...cfg, rebalanceEveryNDays: 5, feeBps: 0, slippageBps: 10 },
    { scorer: rotScorer },
  );
  const sell = r.trades.find((t) => t.side === "sell" && t.symbol === "A")!;
  assert.equal(sell.price, 99.9); // 100 * (1 - 10bps)
});

test("buy signals for never-priced symbols surface an explicit warning", async () => {
  // L's bars start mid-window (e.g. IPO): before its first bar there is no
  // price to trade or mark at, so the buy signal must be flagged, not dropped.
  const series: SymbolSeries[] = [
    { entry: { symbol: "A", name: "Up", theme: "T" }, klines: makeKlines("2025-01-01", Array.from({ length: 80 }, (_, i) => 100 + i)) },
    { entry: { symbol: "L", name: "Late", theme: "T" }, klines: makeKlines("2025-02-17", Array.from({ length: 40 }, (_, i) => 50 + i * 0.5)) },
  ];
  const buyL: Scorer = async (snapshots) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: s.symbol === "L" ? "buy" : "hold",
      confidence: 1,
      size: s.symbol === "L" ? 1 : 0,
      rationale: "test",
    }));
  const r = await runBacktest(series, cfg, { scorer: buyL });
  assert.ok(r.warnings?.some((w) => w.includes("L") && w.includes("尚无行情")));
  assert.ok(!r.trades.some((t) => t.symbol === "L" && t.date < "2025-02-17"));
  assert.ok(r.trades.some((t) => t.symbol === "L" && t.side === "buy"));
});

test("delta rebalance does not wash positions that stay in the TopN", async () => {
  // A is the top signal at every rebalance — it must never be sold just to be
  // rebought (the old liquidate-then-rebuild behavior paid fee twice).
  const r = await runBacktest(makeSeries(), { ...cfg, feeBps: 100 }, { scorer });
  const sells = r.trades.filter((t) => t.side === "sell");
  assert.equal(sells.length, 0, "no sell trades expected while A stays in the TopN");
});

function dropDate(klines: Kline[], date: string): Kline[] {
  return klines.filter((k) => k.date !== date);
}

test("suspension on rebalance day skips the untradable buy and records a warning", async () => {
  const series = makeSeries();
  series[1] = { ...series[1], klines: dropDate(series[1].klines, "2025-01-08") };
  const rotatingScorer: Scorer = async (snapshots, opts) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? "buy" : "hold",
      confidence: 1,
      size: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? 1 : 0,
      rationale: "rotate",
    }));
  const r = await runBacktest(series, cfg, { scorer: rotatingScorer });
  // B has no bar on 2025-01-08: no B trade that day, warning recorded, but the
  // day itself is kept (union alignment) and B is bought next rebalance day.
  assert.ok(!r.trades.some((t) => t.date === "2025-01-08" && t.symbol === "B"));
  assert.ok(r.warnings?.some((w) => w.includes("2025-01-08") && w.includes("B")));
  assert.ok(r.equityCurve.some((b) => b.date === "2025-01-08"));
  assert.ok(r.trades.some((t) => t.date === "2025-01-15" && t.symbol === "B" && t.side === "buy"));
});

test("held position that turns untradable on rebalance day is kept and marked at last close", async () => {
  const series = makeSeries();
  series[1] = { ...series[1], klines: dropDate(series[1].klines, "2025-01-08") };
  const holdBThenA: Scorer = async (snapshots, opts) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: s.symbol === (opts.asOf < "2025-01-08" ? "B" : "A") ? "buy" : "hold",
      confidence: 1,
      size: s.symbol === (opts.asOf < "2025-01-08" ? "B" : "A") ? 1 : 0,
      rationale: "rotate",
    }));
  const r = await runBacktest(series, cfg, { scorer: holdBThenA });
  // B cannot be sold on 2025-01-08 (no bar); the position survives at the
  // 2025-01-07 close (98.5) instead of being force-liquidated or dropped.
  assert.ok(!r.trades.some((t) => t.date === "2025-01-08" && t.symbol === "B" && t.side === "sell"));
  const bar = r.equityCurve.find((b) => b.date === "2025-01-08")!;
  assert.ok(bar.positions.B, "B position should survive its suspended rebalance day");
  assert.equal(bar.positions.B.price, 98.5);
  assert.ok(r.warnings?.some((w) => w.includes("B")));
});
