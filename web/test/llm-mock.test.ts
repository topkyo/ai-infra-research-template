import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, scorePortfolioTargets, scoreSymbols } from "../lib/deepseek";

function snap(symbol: string, closes: number[]) {
  return { symbol, closes };
}

const UP = Array.from({ length: 20 }, (_, i) => 100 + i);   // +19% window
const DOWN = Array.from({ length: 20 }, (_, i) => 100 - i); // -19% window
const FLAT = Array.from({ length: 20 }, () => 100);

test("mock provider returns deterministic offline signals without network", async () => {
  const old = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
  try {
    const signals = await scoreSymbols([snap("AAA", UP), snap("BBB", DOWN), snap("CCC", FLAT)]);
    assert.deepEqual(signals.map((s) => s.action), ["buy", "sell", "hold"]);
    assert.ok(signals[0].size > 0);
    assert.equal(signals[1].size, 0);
    // Mock output must be distinguishable from real LLM output downstream.
    assert.ok(signals.every((s) => s.source === "llm-mock"));

    // Deterministic: same input, same output.
    const again = await scoreSymbols([snap("AAA", UP)]);
    assert.equal(again[0].action, "buy");
    assert.equal(again[0].size, signals[0].size);

    const targets = await scorePortfolioTargets([snap("AAA", UP), snap("BBB", DOWN)]);
    assert.ok(targets[0].targetWeight > 0);
    assert.equal(targets[1].targetWeight, 0);
    assert.ok(targets.every((t) => t.source === "llm-mock"));

    // Code paths without a mock implementation fail explicitly (no silent
    // degradation): chat/universe-refresh style calls must throw.
    await assert.rejects(
      () => chat([{ role: "user", content: "hi" }]),
      /no mock implementation/,
    );
  } finally {
    if (old === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = old;
  }
});

test("mock provider still enforces input validation", async () => {
  const old = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
  try {
    // Fewer than MIN_SCORABLE_KLINES closes must throw, mock or not.
    await assert.rejects(
      () => scoreSymbols([snap("AAA", [1, 2, 3])]),
      /insufficient live kline data/,
    );
    await assert.rejects(
      () => scoreSymbols([snap("AAA", UP), snap("AAA", UP)]),
      /duplicate input symbols/,
    );
  } finally {
    if (old === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = old;
  }
});
