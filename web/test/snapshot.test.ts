import { test } from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../lib/pyserver";
import {
  assertFullSignalCoverage,
  assertNoLoadErrors,
  buildAnalystFallback,
  loadBacktestSeries,
  loadSignalSnapshot,
} from "../scripts/snapshot";

const entry = { symbol: "000001", name: "平安银行", theme: "云/AI基建" };

function klines(count: number): Kline[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1_000_000,
  }));
}

function fulfilled<T>(value: T): PromiseFulfilledResult<T> {
  return { status: "fulfilled", value };
}

function rejected(reason: unknown): PromiseRejectedResult {
  return { status: "rejected", reason };
}

test("snapshot signal loader fails hard on missing or insufficient klines", () => {
  const failed = loadSignalSnapshot(entry, rejected(new Error("kline timeout")), fulfilled({ symbol: "000001" }));
  assert.match(failed.error ?? "", /000001.*kline timeout/);

  const short = loadSignalSnapshot(entry, fulfilled(klines(9)), fulfilled({ symbol: "000001" }));
  assert.match(short.error ?? "", /000001.*only 9 bars/);

  assert.throws(
    () => assertNoLoadErrors("signals", [failed.error!, short.error!]),
    /snapshot signals data load failed for 2 symbols/,
  );
});

test("snapshot signal loader keeps fundamental failures as warnings", () => {
  const loaded = loadSignalSnapshot(entry, fulfilled(klines(10)), rejected(new Error("fundamental unavailable")));
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.value?.symbol, "000001");
  assert.equal(loaded.value?.closes.length, 10);
  assert.match(loaded.warnings[0], /fundamental unavailable/);
});

test("snapshot backtest loader fails hard on missing or insufficient klines", () => {
  const failed = loadBacktestSeries(entry, rejected("pyserver down"), fulfilled({ symbol: "000001" }));
  assert.match(failed.error ?? "", /000001.*pyserver down/);

  const short = loadBacktestSeries(entry, fulfilled(klines(19)), fulfilled({ symbol: "000001" }));
  assert.match(short.error ?? "", /000001.*only 19 bars/);

  assert.throws(
    () => assertNoLoadErrors("backtest", [failed.error!, short.error!]),
    /snapshot backtest data load failed for 2 symbols/,
  );
});

test("snapshot analyst fallback exposes the analyst failure and spot source", () => {
  const fallback = buildAnalystFallback("000001", new Error("analyst 502"), {
    symbol: "000001",
    name: "平安银行",
    price: 12.34,
    change_pct: 1.2,
    source: "test_spot",
    fetched_at: "2026-01-01T00:00:00Z",
    warnings: ["daily close"],
  });

  assert.equal(fallback.current_price, 12.34);
  assert.equal(fallback.source, "spot_fallback:test_spot");
  assert.match(fallback.error ?? "", /analyst failed: analyst 502/);
  assert.deepEqual(fallback.warnings, [
    "analyst unavailable; current_price filled from spot endpoint",
    "spot warning: daily close",
  ]);
});

test("snapshot signal coverage rejects missing duplicate and unknown symbols", () => {
  assert.doesNotThrow(() => assertFullSignalCoverage(["A", "B"], [
    { symbol: "A", action: "hold", confidence: 0.5, size: 0, rationale: "ok" },
    { symbol: "B", action: "sell", confidence: 0.4, size: 0, rationale: "ok" },
  ]));

  assert.throws(
    () => assertFullSignalCoverage(["A", "B"], [
      { symbol: "A", action: "hold", confidence: 0.5, size: 0, rationale: "ok" },
      { symbol: "A", action: "buy", confidence: 0.8, size: 0.3, rationale: "dup" },
      { symbol: "C", action: "sell", confidence: 0.4, size: 0, rationale: "unknown" },
    ]),
    /missing: B; duplicate: A; unknown: C/,
  );
});
