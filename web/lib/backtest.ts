// Bar-by-bar backtest engine. Walks the price series forward, asks DeepSeek
// for signals every `rebalanceEveryNDays` bars using only data available at
// that point (look-ahead-free), and applies them to a virtual portfolio.
//
// Signals are cached by (model, messages) hash, so re-running the same
// backtest is free in tokens — only adding new bars or symbols pays cost.
import type { Kline } from "./pyserver";
import { scoreSymbols, type SymbolSnapshot, type Signal } from "./deepseek";
import type { UniverseEntry } from "./universe";

export interface BacktestConfig {
  startCash: number;
  rebalanceEveryNDays: number;
  startDate: string;         // YYYY-MM-DD
  endDate: string;
  feeBps: number;            // one-way trading fee in basis points
  slippageBps?: number;      // one-way slippage in basis points (default 0)
  /** Respect daily price-limit seals (default true): no buys at limit-up,
   *  no sells at limit-down. HK has no daily limits. */
  respectPriceLimits?: boolean;
  maxPositions: number;
}

export interface PortfolioBar {
  date: string;
  equity: number;
  cash: number;
  positions: Record<string, { shares: number; price: number }>;
}

export interface BacktestResult {
  config: BacktestConfig;
  equityCurve: PortfolioBar[];
  trades: Array<{
    date: string;
    symbol: string;
    side: "buy" | "sell";
    shares: number;
    price: number;
  }>;
  signalsByDate: Record<string, Signal[]>;
  /** Auditable data gaps, e.g. symbols without a bar on a rebalance day. */
  warnings?: string[];
  stats: {
    totalReturnPct: number;
    cagrPct: number;
    maxDrawdownPct: number;
    sharpe: number;
    trades: number;
    excessReturnPct?: number;
  };
  benchmark?: BenchmarkResult;
}

export interface BenchmarkResult {
  id: string;
  name: string;
  equityCurve: Array<{ date: string; equity: number }>;
  stats: {
    totalReturnPct: number;
    cagrPct: number;
    maxDrawdownPct: number;
    sharpe: number;
    trades: number;
  };
}

export interface SymbolSeries {
  entry: UniverseEntry;
  klines: Kline[];
  fundamental?: SymbolSnapshot["fundamental"];
}

function alignedTradingDates(series: SymbolSeries[]): string[] {
  // Union of all series' dates. A symbol without a bar on a given date (e.g.
  // suspension) is marked at its last available close and cannot trade that
  // day, instead of dropping the day for the whole portfolio (intersection
  // would let one suspended name compress the entire sample).
  const all = new Set<string>();
  series.forEach((s) => s.klines.forEach((k) => all.add(k.date)));
  return [...all].sort();
}

function indexByDate(klines: Kline[]) {
  const m = new Map<string, Kline>();
  for (const k of klines) m.set(k.date, k);
  return m;
}

/** Board-based daily price-limit fraction; 0 means no daily limit (HK).
 *  ST ±5% is not modeled — the data carries no ST flag. */
function priceLimitFraction(symbol: string): number {
  const s = symbol.toLowerCase();
  if (s.includes("hk")) return 0;
  const digits = s.replace(/\D/g, "");
  if (/^(68|30)/.test(digits)) return 0.2;   // 科创板 / 创业板
  if (/^(8|4|920)/.test(digits)) return 0.3; // 北交所
  return 0.1;                                 // 主板
}

export type Progress =
  | { phase: "signals"; done: number; total: number }
  | { phase: "simulating"; done: number; total: number };


function computeStatsFromEquities(equities: number[], trades = 0) {
  if (equities.length === 0) {
    throw new Error("backtest equity curve is empty");
  }
  const start = equities[0];
  const end = equities[equities.length - 1];
  if (!Number.isFinite(start) || start <= 0) {
    throw new Error(`backtest start equity must be finite and positive (got ${start})`);
  }
  if (!Number.isFinite(end)) {
    throw new Error(`backtest end equity must be finite (got ${end})`);
  }
  const totalReturnPct = (end / start - 1) * 100;
  const years = equities.length / 252;
  const cagrPct = (Math.pow(end / start, 1 / Math.max(years, 1 / 252)) - 1) * 100;
  let peak = start;
  let maxDD = 0;
  for (const e of equities) {
    peak = Math.max(peak, e);
    maxDD = Math.min(maxDD, e / peak - 1);
  }
  const rets: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    rets.push(equities[i] / equities[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  return { totalReturnPct, cagrPct, maxDrawdownPct: maxDD * 100, sharpe, trades };
}

function computeBenchmarkResult(
  dates: string[],
  klines: Kline[],
  startCash: number,
  meta: { id: string; name: string },
  strategyTotalReturnPct: number,
): BenchmarkResult | undefined {
  const byDate = indexByDate(klines);
  const first = byDate.get(dates[0]);
  if (!first || first.close <= 0) return undefined;
  const units = startCash / first.close;
  let lastPx = first.close;
  const equityCurve = dates.map((d) => {
    const k = byDate.get(d);
    if (k) lastPx = k.close;
    return { date: d, equity: units * lastPx };
  });
  const stats = computeStatsFromEquities(equityCurve.map((b) => b.equity));
  return {
    id: meta.id,
    name: meta.name,
    equityCurve,
    stats,
    excessReturnPct: strategyTotalReturnPct - stats.totalReturnPct,
  } as BenchmarkResult & { excessReturnPct?: number };
}

export type Scorer = (
  snapshots: SymbolSnapshot[],
  opts: { asOf: string; mode: "backtest"; batchSize?: number },
) => Promise<Signal[]>;

export interface RunBacktestOptions {
  onProgress?: (p: Progress) => void;
  onLog?: (message: string) => void;
  /** Override the LLM scorer — used by tests to inject deterministic signals. */
  scorer?: Scorer;
  benchmark?: { id: string; name: string; klines: Kline[] };
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function runBacktest(
  series: SymbolSeries[],
  cfg: BacktestConfig,
  optsOrOnProgress?: RunBacktestOptions | ((p: Progress) => void),
): Promise<BacktestResult> {
  const opts: RunBacktestOptions = typeof optsOrOnProgress === "function"
    ? { onProgress: optsOrOnProgress }
    : (optsOrOnProgress ?? {});
  const onProgress = opts.onProgress;
  const onLog = opts.onLog;
  const backtestBatchSize = envPositiveInt(
    "BACKTEST_LLM_SCORE_BATCH_SIZE",
    envPositiveInt("LLM_SCORE_BATCH_SIZE", 40),
  );
  const dates = alignedTradingDates(series).filter(
    (d) => d >= cfg.startDate && d <= cfg.endDate,
  );
  if (dates.length < 5) {
    throw new Error(`Not enough aligned trading days (${dates.length}) in window`);
  }

  const byDate = series.map((s) => indexByDate(s.klines));
  const symbols = series.map((s) => s.entry.symbol);

  const t0 = Date.now();
  // Pre-fetch ALL rebalance signals in parallel. Signals at date D depend
  // only on price history <= D, never on what we held — independent calls.
  // Cached entries return instantly; uncached fire concurrently (bounded).
  const rebalanceDates = dates.filter((_, i) => i % cfg.rebalanceEveryNDays === 0);
  const batchesPerDate = Math.max(1, Math.ceil(series.length / backtestBatchSize));
  const totalSignalUnits = rebalanceDates.length * batchesPerDate;
  let signalsDone = 0;
  const inFlightBatches = new Map<string, number>();
  const scorer: Scorer = opts.scorer ?? ((snapshots, scoreOpts) =>
    scoreSymbols(snapshots, {
      ...scoreOpts,
      mode: "backtest",
      batchSize: backtestBatchSize,
      onBatchProgress: (done, total) => {
        inFlightBatches.set(scoreOpts.asOf, done);
        const inflight = [...inFlightBatches.values()].reduce((a, b) => a + b, 0);
        onProgress?.({
          phase: "signals",
          done: signalsDone * batchesPerDate + inflight,
          total: totalSignalUnits,
        });
        onLog?.(`LLM 批次 ${done}/${total}（调仓 ${scoreOpts.asOf}）`);
      },
    }));
  const signalsByDate: Record<string, Signal[]> = {};
  const CONCURRENCY = envPositiveInt("BACKTEST_SIGNAL_CONCURRENCY", 8);
  onProgress?.({ phase: "signals", done: 0, total: totalSignalUnits });
  for (let i = 0; i < rebalanceDates.length; i += CONCURRENCY) {
    const slice = rebalanceDates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (d) => {
        const snapshots: SymbolSnapshot[] = series.map((s) => {
          const upto = s.klines.filter((k) => k.date <= d);
          return {
            symbol: s.entry.symbol,
            name: s.entry.name,
            theme: s.entry.theme,
            closes: upto.map((k) => k.close),
            fundamental: s.fundamental,
          };
        });
        const sigs = await scorer(snapshots, { asOf: d, mode: "backtest", batchSize: backtestBatchSize });
        inFlightBatches.delete(d);
        signalsDone++;
        onProgress?.({ phase: "signals", done: signalsDone * batchesPerDate, total: totalSignalUnits });
        return [d, sigs] as const;
      }),
    );
    for (const [d, sigs] of results) signalsByDate[d] = sigs;
  }
  console.log(
    `[backtest] fetched ${rebalanceDates.length} rebalance signals in ${
      ((Date.now() - t0) / 1000).toFixed(1)
    }s (concurrency=${CONCURRENCY})`,
  );

  let cash = cfg.startCash;
  const shares: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 0]));
  const equityCurve: PortfolioBar[] = [];
  const trades: BacktestResult["trades"] = [];
  const warnings: string[] = [];
  const fee = cfg.feeBps / 10_000;
  const slip = (cfg.slippageBps ?? 0) / 10_000;
  const respectLimits = cfg.respectPriceLimits !== false;
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

  const noteWarning = (message: string) => {
    if (warnings.length < 200) {
      warnings.push(message);
    } else if (warnings.length === 200) {
      warnings.push("...后续警告已截断");
    }
    onLog?.(message);
  };

  const progressEvery = Math.max(1, Math.floor(dates.length / 20));
  onProgress?.({ phase: "simulating", done: 0, total: dates.length });
  const lastClose: (number | undefined)[] = series.map(() => undefined);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (i % progressEvery === 0 || i === dates.length - 1) {
      onProgress?.({ phase: "simulating", done: i + 1, total: dates.length });
    }
    // Mark prices: today's close when a bar exists, otherwise carry the last
    // known close forward. Only symbols with a real bar today are tradable.
    const prices: Record<string, number> = {};
    const tradable: Record<string, boolean> = {};
    const limitState: Record<string, "up" | "down" | null> = {};
    for (let j = 0; j < symbols.length; j++) {
      const k = byDate[j].get(date);
      const prevClose = lastClose[j];
      if (k) {
        lastClose[j] = k.close;
        tradable[symbols[j]] = true;
        if (respectLimits && prevClose !== undefined && prevClose > 0) {
          const limit = priceLimitFraction(symbols[j]);
          if (limit > 0) {
            const pct = k.close / prevClose - 1;
            // 0.2% tolerance: limit prices round to 0.01 CNY and qfq
            // adjustment adds noise, so a sealed board prints slightly off.
            if (pct >= limit - 0.002) limitState[symbols[j]] = "up";
            else if (pct <= -(limit - 0.002)) limitState[symbols[j]] = "down";
          }
        }
      }
      const px = lastClose[j];
      if (px !== undefined) prices[symbols[j]] = px;
    }

    // Rebalance day? 信号与成交均使用当日收盘价（含首个调仓日 i=0），
    // 日频回测不建模盘中路径。
    if (i % cfg.rebalanceEveryNDays === 0) {
      const signals = signalsByDate[date] ?? [];

      // Buy candidates with no price at all in the window (e.g. mid-window
      // IPO, or suspended since before startDate) can never trade. Surface
      // them explicitly instead of silently dropping the signal.
      const buySignals = signals.filter((s) => s.action === "buy" && s.size > 0);
      for (const s of buySignals) {
        if (prices[s.symbol] === undefined) {
          noteWarning(`${date} 调仓日 ${s.symbol} 窗口内尚无行情，无法买入`);
        }
      }
      const buys = buySignals
        .filter((s) => (prices[s.symbol] ?? 0) > 0)
        .sort((a, b) => b.confidence * b.size - a.confidence * a.size)
        .slice(0, cfg.maxPositions);

      // Delta rebalance: size targets from current equity, then trade only the
      // difference. Positions staying in the TopN are adjusted in place instead
      // of washed through a sell→buy round-trip (which paid fee+slippage twice);
      // positions that left the TopN exit fully. maxPositions stays a hard cap.
      let equity = cash;
      for (const sym of symbols) {
        if ((shares[sym] ?? 0) > 0 && prices[sym] !== undefined) {
          equity += shares[sym] * prices[sym];
        }
      }
      const totalWeight = buys.reduce((sum, s) => sum + s.size * s.confidence, 0) || 1;
      const targetValue = new Map<string, number>();
      for (const sig of buys) {
        targetValue.set(sig.symbol, equity * ((sig.size * sig.confidence) / totalWeight));
      }

      const skipUntradable = (sym: string) => {
        noteWarning(`${date} 调仓日 ${sym} 无当日行情（停牌或缺数据），跳过交易，持仓按最近收盘价估值`);
      };

      // Sells first (full exits, then overweight trims) so cash is available.
      // T+1 is structural here: each symbol trades at most once per day in one
      // direction, and daily bars mean sold shares were settled on prior days.
      for (const sym of symbols) {
        const held = shares[sym] ?? 0;
        if (held <= 0) continue;
        const px = prices[sym];
        if (px === undefined) continue;
        const target = targetValue.get(sym) ?? 0;
        const excessValue = held * px - target;
        if (excessValue <= 0) continue;
        if (!tradable[sym]) {
          skipUntradable(sym);
          continue;
        }
        if (limitState[sym] === "down") {
          noteWarning(`${date} 调仓日 ${sym} 跌停封板，无法卖出`);
          continue;
        }
        const exec = round4(px * (1 - slip));
        const sh = target > 0
          ? Math.min(held, Math.floor(excessValue / exec / 100) * 100)
          : held;
        if (sh <= 0) continue;
        cash += sh * exec * (1 - fee);
        shares[sym] = held - sh;
        trades.push({ date, symbol: sym, side: "sell", shares: sh, price: exec });
      }

      // Buys: bring underweight targets up toward their target value.
      for (const sig of buys) {
        const sym = sig.symbol;
        const px = prices[sym];
        if (px === undefined) continue;
        const held = shares[sym] ?? 0;
        const deficit = (targetValue.get(sym) ?? 0) - held * px;
        if (deficit <= 0) continue;
        if (!tradable[sym]) {
          skipUntradable(sym);
          continue;
        }
        if (limitState[sym] === "up") {
          noteWarning(`${date} 调仓日 ${sym} 涨停封板，无法买入`);
          continue;
        }
        const exec = round4(px * (1 + slip));
        const sh = Math.floor(Math.min(deficit, cash) / (exec * (1 + fee)) / 100) * 100; // 100-lot
        if (sh <= 0) continue;
        const cost = sh * exec * (1 + fee);
        if (cost > cash) continue;
        cash -= cost;
        shares[sym] = held + sh;
        trades.push({ date, symbol: sym, side: "buy", shares: sh, price: exec });
      }
    }

    // Mark-to-market
    let equity = cash;
    const positions: PortfolioBar["positions"] = {};
    for (const sym of symbols) {
      if (shares[sym] > 0 && prices[sym] !== undefined) {
        const px = prices[sym];
        equity += shares[sym] * px;
        positions[sym] = { shares: shares[sym], price: px };
      }
    }
    equityCurve.push({ date, equity, cash, positions });
  }

  // Stats — single implementation shared with the benchmark computation.
  const equities = equityCurve.map((b) => b.equity);
  const stats: BacktestResult["stats"] = computeStatsFromEquities(equities, trades.length);

  let benchmark: BenchmarkResult | undefined;
  if (opts.benchmark) {
    const bench = computeBenchmarkResult(
      dates,
      opts.benchmark.klines,
      cfg.startCash,
      { id: opts.benchmark.id, name: opts.benchmark.name },
      stats.totalReturnPct,
    );
    if (bench) {
      benchmark = bench;
      stats.excessReturnPct = bench.stats.totalReturnPct != null
        ? stats.totalReturnPct - bench.stats.totalReturnPct
        : undefined;
    }
  }

  return {
    config: cfg,
    equityCurve,
    trades,
    signalsByDate,
    warnings: warnings.length > 0 ? warnings : undefined,
    stats,
    benchmark,
  };
}
