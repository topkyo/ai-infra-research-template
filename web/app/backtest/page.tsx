"use client";
import { useState } from "react";
import Link from "next/link";
import { SITE_EYEBROW } from "@/lib/site";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { BacktestResult } from "@/lib/backtest";
import { readNdjsonStream } from "@/lib/ndjson";

type Phase = "loading" | "signals" | "simulating";

interface Progress {
  phase: Phase;
  done: number;
  total: number;
}

const PHASE_LABEL: Record<Phase, string> = {
  loading: "加载行情与基本面",
  signals: "DeepSeek 信号生成",
  simulating: "回测撮合",
};

// Weights of each phase in the overall bar (must sum to 1).
const PHASE_WEIGHT: Record<Phase, number> = {
  loading: 0.15,
  signals: 0.75,
  simulating: 0.10,
};
const PHASE_ORDER: Phase[] = ["loading", "signals", "simulating"];

export default function BacktestPage() {
  const [startDate, setStartDate] = useState("2024-01-01");
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [rebalance, setRebalance] = useState(10);
  const [maxPositions, setMaxPositions] = useState(6);
  const [startCash, setStartCash] = useState(1_000_000);
  const [feeBps, setFeeBps] = useState(10);
  const [slippageBps, setSlippageBps] = useState(5);
  const [respectLimits, setRespectLimits] = useState(true);
  const [benchmarkIndex, setBenchmarkIndex] = useState("csi300");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  function overallPct(p: Progress | null): number {
    if (!p) return 0;
    let pct = 0;
    for (const ph of PHASE_ORDER) {
      if (ph === p.phase) {
        pct += PHASE_WEIGHT[ph] * (p.total > 0 ? p.done / p.total : 0);
        break;
      }
      pct += PHASE_WEIGHT[ph];
    }
    return Math.min(1, pct);
  }

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setLogs([]);
    let gotResult = false;
    let gotError = false;
    try {
      const r = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          rebalanceEveryNDays: rebalance,
          maxPositions,
          benchmarkIndex,
          startCash,
          feeBps,
          slippageBps,
          respectPriceLimits: respectLimits,
        }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

      type Evt =
        | { type: "progress"; phase: Phase; done: number; total: number }
        | { type: "log"; message: string }
        | { type: "result"; result: BacktestResult }
        | { type: "error"; message: string };
      await readNdjsonStream<Evt>(r.body, (evt) => {
        if (evt.type === "progress") {
          setProgress({ phase: evt.phase, done: evt.done, total: evt.total });
        } else if (evt.type === "log") {
          setLogs((prev) => [...prev, evt.message]);
        } else if (evt.type === "result") {
          gotResult = true;
          setResult(evt.result);
        } else if (evt.type === "error") {
          gotError = true;
          setResult(null);
          setError(evt.message);
        }
      }, (line) => {
        setLogs((prev) => [...prev, `跳过无法解析的响应行（${line.length} 字符）`]);
      });
      if (!gotResult && !gotError) {
        setError(
          "回测未完成（连接中断或服务超时）。请先缩短日期区间（如 1–3 个月）试跑，或查看 ~/Library/Logs/topkyo-ai-infra/*.log",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const pct = overallPct(progress);

  return (
    <div className="container">
      <Link href="/" className="back-link">返回股票池</Link>
      <header className="page-header compact">
        <div>
          <div className="eyebrow">{SITE_EYEBROW}</div>
          <h1>策略回测</h1>
          <p>按固定周期重配至目标权重（增量调仓，避免重复买卖），计入单边费率与滑点，涨停不可买、跌停不可卖（可关闭），与基准指数对比。信号与成交均基于当日收盘价。任一调仓日信号失败时回测终止，不生成权益曲线；调仓日缺行情的标的跳过交易并按最近收盘价估值，以警告显式列出。</p>
        </div>
      </header>

      <div className="toolbar">
        <label className="field">
          <span>起始</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="field">
          <span>结束</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        <label className="field">
          <span>调仓周期</span>
          <input type="number" min={1} max={60} value={rebalance}
            onChange={(e) => setRebalance(+e.target.value)} />
        </label>
        <label className="field">
          <span>最大持仓数</span>
          <input type="number" min={1} max={20} value={maxPositions}
            onChange={(e) => setMaxPositions(+e.target.value)} />
        </label>
        <label className="field">
          <span>初始资金</span>
          <input type="number" min={10000} step={10000} value={startCash}
            onChange={(e) => setStartCash(+e.target.value)} />
        </label>
        <label className="field">
          <span>费率(bps)</span>
          <input type="number" min={0} max={200} value={feeBps}
            onChange={(e) => setFeeBps(+e.target.value)} />
        </label>
        <label className="field">
          <span>滑点(bps)</span>
          <input type="number" min={0} max={100} value={slippageBps}
            onChange={(e) => setSlippageBps(+e.target.value)} />
        </label>
        <label className="field">
          <span>基准指数</span>
          <select value={benchmarkIndex} onChange={(e) => setBenchmarkIndex(e.target.value)}>
            <option value="csi300">沪深300</option>
            <option value="star50">科创50</option>
            <option value="csi500">中证500</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={respectLimits}
            onChange={(e) => setRespectLimits(e.target.checked)} />
          <span>涨跌停限制</span>
        </label>
        <button onClick={run} disabled={loading}>
          {loading ? "运行中…" : "运行回测"}
        </button>
      </div>

      {(loading || progress) && (
        <div className="card spaced-top">
          <div className="fetch-progress-meta progress-title">
            <span>
              {progress ? PHASE_LABEL[progress.phase] : "准备中…"}
              {progress && `  ${progress.done} / ${progress.total}`}
            </span>
            <span>{(pct * 100).toFixed(0)}%</span>
          </div>
          <div className="fetch-progress-track">
            <div className="fetch-progress-bar" style={{ width: `${pct * 100}%` }} />
          </div>
          {logs.length > 0 && (
            <div className="progress-logs">
              <div className="progress-logs-latest">· {logs[logs.length - 1]}</div>
              {logs.length > 1 && (
                <details className="progress-logs-more">
                  <summary>更早日志（{logs.length - 1} 条）</summary>
                  {logs.slice(0, -1).map((l, i) => <div key={i}>· {l}</div>)}
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="card spaced-top card-danger">
          <strong>失败：</strong> {error}
        </div>
      )}

      {result && result.warnings && result.warnings.length > 0 && (
        <div className="card spaced-top card-warn">
          <strong>数据警告（{result.warnings.length}）：</strong>
          调仓日存在缺行情（停牌/缺数据）标的，已跳过其交易并按最近收盘价估值。
          <details className="progress-logs-more">
            <summary>查看明细</summary>
            {result.warnings.slice(0, 20).map((w, i) => <div key={i}>· {w}</div>)}
          </details>
        </div>
      )}

      {result && (
        <>
          <div className="row spaced-top">
            <Kpi label="总收益" value={`${result.stats.totalReturnPct.toFixed(2)}%`} pos={result.stats.totalReturnPct >= 0} />
            <Kpi label="年化" value={`${result.stats.cagrPct.toFixed(2)}%`} pos={result.stats.cagrPct >= 0} />
            <Kpi label="最大回撤" value={`${result.stats.maxDrawdownPct.toFixed(2)}%`} pos={false} />
            <Kpi label="夏普" value={result.stats.sharpe.toFixed(2)} pos={result.stats.sharpe >= 0} />
            <Kpi label="交易次数" value={result.stats.trades.toString()} />
            {result.stats.excessReturnPct != null && (
              <Kpi
                label="超额收益(vs基准)"
                value={`${result.stats.excessReturnPct.toFixed(2)}%`}
                pos={result.stats.excessReturnPct >= 0}
              />
            )}
          </div>

          <h2 className="subheading">权益曲线</h2>
          <div className="card chart-card">
            <ResponsiveContainer>
              <LineChart data={result.equityCurve.map((b) => {
                const bench = result.benchmark?.equityCurve.find((x) => x.date === b.date);
                return { date: b.date, equity: b.equity, benchmark: bench?.equity };
              })}>
                <CartesianGrid strokeDasharray="3 3" stroke="#d9e2ec" />
                <XAxis dataKey="date" stroke="#667085" minTickGap={40} />
                <YAxis stroke="#667085" domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "#ffffff", border: "1px solid #d9e2ec", color: "#172033" }}
                  labelStyle={{ color: "#667085" }}
                  formatter={(v: number) => v.toFixed(0)}
                />
                <Line type="monotone" dataKey="equity" name="策略" stroke="#0f8f5f" dot={false} strokeWidth={2} />
                {result.benchmark && (
                  <Line type="monotone" dataKey="benchmark" name={result.benchmark.name} stroke="#2563eb" dot={false} strokeWidth={1.5} strokeDasharray="4 4" />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <h2 className="subheading">最近交易</h2>
          <div className="theme-panel">
            <div className="table-wrap compact-table">
            <table>
              <thead>
                <tr><th>日期</th><th>代码</th><th>方向</th><th>数量</th><th>价格</th></tr>
              </thead>
              <tbody>
                {result.trades.slice(-30).reverse().map((t, i) => (
                  <tr key={i}>
                    <td>{t.date}</td>
                    <td>{t.symbol}</td>
                    <td><span className={`badge ${t.side}`}>{t.side}</span></td>
                    <td>{t.shares}</td>
                    <td>{t.price.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, pos }: { label: string; value: string; pos?: boolean }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className={`value ${pos === undefined ? "" : pos ? "pos" : "neg"}`}>{value}</span>
    </div>
  );
}
