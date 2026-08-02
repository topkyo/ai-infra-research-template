import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYST_BROWSER_CACHE_TTL_MS,
  SPOT_BROWSER_CACHE_TTL_MS,
  readFreshCacheValues,
} from "../app/UniverseTable";

test("browser cache TTLs are layered by data volatility", () => {
  assert.equal(SPOT_BROWSER_CACHE_TTL_MS, 15 * 60 * 1000);
  assert.equal(ANALYST_BROWSER_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.ok(ANALYST_BROWSER_CACHE_TTL_MS > SPOT_BROWSER_CACHE_TTL_MS);
});

test("browser cache prunes expired entries and symbols that left the universe", () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
  };
  try {
    const now = Date.now();
    store.set("topkyo:spot:v4", JSON.stringify({
      AAA: { value: { symbol: "AAA", price: 1 }, fetchedAt: now },
      GONE: { value: { symbol: "GONE", price: 2 }, fetchedAt: now },
      STALE: { value: { symbol: "STALE", price: 3 }, fetchedAt: now - 20 * 60 * 1000 },
    }));
    const values = readFreshCacheValues<{ symbol: string; price: number }>(
      "topkyo:spot:v4",
      ["AAA", "STALE"],
      SPOT_BROWSER_CACHE_TTL_MS,
    );
    // STALE is requested but expired (20min > 15min TTL); GONE left the universe.
    assert.deepEqual(values.map((v) => v.symbol), ["AAA"]);
    const after = JSON.parse(store.get("topkyo:spot:v4")!);
    assert.deepEqual(Object.keys(after), ["AAA"]);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});
