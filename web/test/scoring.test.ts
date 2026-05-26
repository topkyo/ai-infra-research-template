import { test } from "node:test";
import assert from "node:assert/strict";
import { rankByRules, rulesToSignals } from "../lib/scoring/rules";
import type { SymbolSnapshot } from "../lib/deepseek";

const up: SymbolSnapshot = {
  symbol: "UP",
  theme: "光模块",
  closes: Array.from({ length: 30 }, (_, i) => 100 + i),
  fundamental: { pe_ttm: 20, profit_yoy: 40, pb: 3, market_cap: 1000 },
};

const down: SymbolSnapshot = {
  symbol: "DN",
  theme: "电力",
  closes: Array.from({ length: 30 }, (_, i) => 100 - i * 0.5),
  fundamental: { pe_ttm: 80, profit_yoy: 5, pb: 5, market_cap: 500 },
};

test("rankByRules orders stronger fundamentals+momentum first", () => {
  const ranked = rankByRules([down, up]);
  assert.equal(ranked[0].symbol, "UP");
  assert.ok(ranked[0].score > ranked[1].score);
});

test("rulesToSignals produces buy/hold/sell actions", () => {
  const signals = rulesToSignals(rankByRules([up, down]));
  assert.equal(signals.length, 2);
  assert.ok(["buy", "hold", "sell"].includes(signals[0].action));
});
