// Snapshot the latest webapp results into docs/data/*.json for the static
// GitHub Pages site. Requires pyserver running and DEEPSEEK_API_KEY set
// (read from web/.env.local).
//
// Usage:
//   cd web && npx tsx scripts/snapshot.ts
//
// Env overrides:
//   SNAPSHOT_BACKTEST_START=2024-01-01  SNAPSHOT_BACKTEST_END=2026-05-14
//   SNAPSHOT_SKIP_SIGNALS=1  SNAPSHOT_SKIP_BACKTEST=1
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SymbolSeries } from "../lib/backtest";
import type { Signal, SymbolSnapshot } from "../lib/deepseek";
import type { Analyst, Fundamental, Kline, Spot } from "../lib/pyserver";
import type { UniverseEntry } from "../lib/universe";

// Load .env.local BEFORE importing modules that read process.env at module scope.
(() => {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k]) continue;
    process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
})();

const MIN_SIGNAL_KLINES = 10;
const MIN_BACKTEST_KLINES = 20;

interface SnapshotLoad<T> {
  value?: T;
  error?: string;
  warnings: string[];
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortMessage(message: string, max = 160): string {
  return message.length > max ? `${message.slice(0, max)}...` : message;
}

export function assertFullSignalCoverage(
  expectedSymbols: string[],
  signals: Signal[],
): void {
  const expected = new Set(expectedSymbols);
  const seen = new Set<string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];

  for (const signal of signals) {
    if (!expected.has(signal.symbol)) unknown.push(signal.symbol);
    if (seen.has(signal.symbol)) duplicate.push(signal.symbol);
    seen.add(signal.symbol);
  }

  const missing = expectedSymbols.filter((symbol) => !seen.has(symbol));
  const problems = [
    missing.length ? `missing: ${missing.join(",")}` : "",
    duplicate.length ? `duplicate: ${duplicate.join(",")}` : "",
    unknown.length ? `unknown: ${unknown.join(",")}` : "",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(`snapshot signals coverage invalid (${problems.join("; ")})`);
  }
}

export function assertNoLoadErrors(kind: string, errors: string[]): void {
  if (errors.length === 0) return;
  throw new Error(
    `snapshot ${kind} data load failed for ${errors.length} symbols: ${errors.slice(0, 8).join("; ")}`,
  );
}

export function buildAnalystFallback(
  symbol: string,
  analystError: unknown,
  spot: Spot,
): Analyst {
  return {
    symbol,
    current_price: spot.price,
    buy_count: null,
    total_count: null,
    buy_ratio: null,
    consensus_eps_next: null,
    implied_target: null,
    upside_pct: null,
    source: spot.source ? `spot_fallback:${spot.source}` : "spot_fallback",
    fetched_at: spot.fetched_at,
    error: `analyst failed: ${shortMessage(errorMessage(analystError))}`,
    warnings: [
      "analyst unavailable; current_price filled from spot endpoint",
      ...(spot.warnings ?? []).map((warning) => `spot warning: ${warning}`),
    ],
  };
}

export function loadSignalSnapshot(
  entry: UniverseEntry,
  klinesRes: PromiseSettledResult<Kline[]>,
  fundamentalRes: PromiseSettledResult<Fundamental>,
): SnapshotLoad<SymbolSnapshot> {
  const warnings: string[] = [];
  if (klinesRes.status !== "fulfilled") {
    return {
      error: `${entry.symbol} ${entry.name}: ${shortMessage(errorMessage(klinesRes.reason))}`,
      warnings,
    };
  }
  if (klinesRes.value.length < MIN_SIGNAL_KLINES) {
    return {
      error: `${entry.symbol} ${entry.name}: only ${klinesRes.value.length} bars`,
      warnings,
    };
  }

  const fund = fundamentalRes.status === "fulfilled" ? fundamentalRes.value : undefined;
  if (fundamentalRes.status === "rejected") {
    warnings.push(`${entry.symbol} ${entry.name} fundamental: ${shortMessage(errorMessage(fundamentalRes.reason))}`);
  }
  if (fund?.warnings?.length) {
    warnings.push(...fund.warnings.map((warning) => `${entry.symbol} ${entry.name} fundamental warning: ${warning}`));
  }

  return {
    value: {
      symbol: entry.symbol,
      name: entry.name,
      theme: entry.theme,
      closes: klinesRes.value.map((k) => k.close),
      fundamental: fund
        ? { pe_ttm: fund.pe_ttm, pb: fund.pb, market_cap: fund.market_cap, profit_yoy: fund.profit_yoy }
        : undefined,
    },
    warnings,
  };
}

export function loadBacktestSeries(
  entry: UniverseEntry,
  klinesRes: PromiseSettledResult<Kline[]>,
  fundamentalRes: PromiseSettledResult<Fundamental>,
): SnapshotLoad<SymbolSeries> {
  const warnings: string[] = [];
  if (klinesRes.status !== "fulfilled") {
    return {
      error: `${entry.symbol} ${entry.name}: ${shortMessage(errorMessage(klinesRes.reason))}`,
      warnings,
    };
  }
  if (klinesRes.value.length < MIN_BACKTEST_KLINES) {
    return {
      error: `${entry.symbol} ${entry.name}: only ${klinesRes.value.length} bars`,
      warnings,
    };
  }

  const fd = fundamentalRes.status === "fulfilled" ? fundamentalRes.value : undefined;
  if (fundamentalRes.status === "rejected") {
    warnings.push(`${entry.symbol} ${entry.name} fundamental: ${shortMessage(errorMessage(fundamentalRes.reason))}`);
  }
  if (fd?.warnings?.length) {
    warnings.push(...fd.warnings.map((warning) => `${entry.symbol} ${entry.name} fundamental warning: ${warning}`));
  }

  return {
    value: {
      entry,
      klines: klinesRes.value,
      fundamental: fd
        ? { pe_ttm: fd.pe_ttm ?? null, pb: fd.pb ?? null, market_cap: fd.market_cap ?? null, profit_yoy: fd.profit_yoy ?? null }
        : undefined,
    },
    warnings,
  };
}

async function main() {
  // Dynamic imports so env loading above lands before any module-scope reads.
  const { readUniverse } = await import("../lib/universe");
  const { fetchAnalyst, fetchSpot, fetchKlines, fetchFundamental } = await import("../lib/pyserver");
  const { scoreSymbols } = await import("../lib/deepseek");
  const { runBacktest } = await import("../lib/backtest");
  const { mapPool } = await import("../lib/concurrent");

  const OUT = path.resolve(__dirname, "..", "..", "docs", "data");
  fs.mkdirSync(OUT, { recursive: true });

  function write(name: string, value: unknown) {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + "\n");
    console.log(`  wrote docs/data/${name}`);
  }

  console.log("== snapshot ==");
  const u = readUniverse();
  write("universe.json", u);

  // ----- analyst ---------------------------------------------------------
  console.log(`[analyst] fetching ${u.entries.length} symbols…`);
  const analyst = await mapPool(u.entries.map((e) => e.symbol), 4, async (sym, idx) => {
    try {
      const a = await fetchAnalyst(sym);
      process.stdout.write(`  ${idx + 1}/${u.entries.length} ${sym} ok\n`);
      return a;
    } catch (e) {
      try {
        const spot = await fetchSpot(sym);
        process.stdout.write(`  ${idx + 1}/${u.entries.length} ${sym} analyst fallback spot\n`);
        return buildAnalystFallback(sym, e, spot);
      } catch (spotError) {
        process.stdout.write(`  ${idx + 1}/${u.entries.length} ${sym} FAIL\n`);
        return {
          symbol: sym,
          error: `analyst failed: ${shortMessage(errorMessage(e))}; spot failed: ${shortMessage(errorMessage(spotError))}`,
          warnings: ["analyst and spot unavailable"],
        };
      }
    }
  });
  write("analyst.json", { generated_at: new Date().toISOString(), items: analyst });

  // ----- signals ---------------------------------------------------------
  if (!process.env.SNAPSHOT_SKIP_SIGNALS) {
    console.log(`[signals] fetching klines + fundamentals for ${u.entries.length} symbols…`);
    const start90 = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return d.toISOString().slice(0, 10).replaceAll("-", "");
    })();
    const loads = await mapPool(u.entries, 4, async (e) => {
      const [klinesRes, fundRes] = await Promise.allSettled([
        fetchKlines(e.symbol, start90),
        fetchFundamental(e.symbol),
      ]);
      return loadSignalSnapshot(e, klinesRes, fundRes);
    });
    const loadErrors = loads.flatMap((load) => load.error ? [load.error] : []);
    assertNoLoadErrors("signals", loadErrors);
    const warnings = loads.flatMap((load) => load.warnings);
    const snapshots = loads.map((load) => load.value!);
    console.log(`[signals] scoring ${snapshots.length} symbols with DeepSeek…`);
    const signals = await scoreSymbols(snapshots);
    assertFullSignalCoverage(u.entries.map((e) => e.symbol), signals);
    write("signals.json", {
      generated_at: new Date().toISOString(),
      fundamentals: snapshots.map((s) => ({
        symbol: s.symbol,
        pe_ttm: s.fundamental?.pe_ttm ?? null,
        pb: s.fundamental?.pb ?? null,
        market_cap: s.fundamental?.market_cap ?? null,
        profit_yoy: s.fundamental?.profit_yoy ?? null,
      })),
      warnings,
      signals,
    });
  } else {
    console.log("[signals] skipped");
  }

  // ----- backtest --------------------------------------------------------
  if (!process.env.SNAPSHOT_SKIP_BACKTEST) {
    const endDate = process.env.SNAPSHOT_BACKTEST_END ?? new Date().toISOString().slice(0, 10);
    const startDate = process.env.SNAPSHOT_BACKTEST_START
      ?? (() => {
        const d = new Date(endDate);
        d.setFullYear(d.getFullYear() - 1);
        return d.toISOString().slice(0, 10);
      })();
    const padStart = new Date(startDate);
    padStart.setDate(padStart.getDate() - 120);
    const aksStart = padStart.toISOString().slice(0, 10).replaceAll("-", "");
    const aksEnd = endDate.replaceAll("-", "");

    console.log(`[backtest] window ${startDate} → ${endDate} — loading bars…`);
    const loads = await mapPool(u.entries, 6, async (entry) => {
      const [klRes, fdRes] = await Promise.allSettled([
        fetchKlines(entry.symbol, aksStart, aksEnd),
        fetchFundamental(entry.symbol),
      ]);
      return loadBacktestSeries(entry, klRes, fdRes);
    });
    const loadErrors = loads.flatMap((load) => load.error ? [load.error] : []);
    assertNoLoadErrors("backtest", loadErrors);
    const warnings = loads.flatMap((load) => load.warnings);
    const series = loads.map((load) => load.value!);
    console.log(`[backtest] loaded ${series.length}/${u.entries.length}; running…`);

    const cfg = {
      startCash: 1_000_000,
      rebalanceEveryNDays: 10,
      startDate,
      endDate,
      feeBps: 10,
      maxPositions: 6,
    };
    const result = await runBacktest(series, cfg, (p) => {
      if (p.done === p.total || p.done % 5 === 0) {
        process.stdout.write(`  ${p.phase}: ${p.done}/${p.total}\n`);
      }
    });
    write("backtest.json", {
      generated_at: new Date().toISOString(),
      config: result.config,
      stats: result.stats,
      equityCurve: result.equityCurve.map((b) => ({ date: b.date, equity: b.equity, cash: b.cash })),
      trades: result.trades,
      warnings,
    });
  } else {
    console.log("[backtest] skipped");
  }

  write("meta.json", {
    generated_at: new Date().toISOString(),
    universe_count: u.entries.length,
  });
  console.log("done.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
