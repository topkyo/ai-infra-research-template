"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SITE_EYEBROW } from "@/lib/site";
import type { UniverseEntry } from "@/lib/universe";

type Phase = "loading" | "scoring";
type PortfolioAction = "open" | "add" | "hold" | "trim" | "exit" | "watch";
type PortfolioMode = "real" | "paper";

interface Progress {
  phase: Phase;
  done: number;
  total: number;
}

interface SignalRow {
  entry: UniverseEntry;
  snapshot: {
    symbol: string;
    name?: string | null;
    theme?: string;
    latestDate?: string | null;
    closes: number[];
    dataErrors?: string[];
    fundamentalSource?: string | null;
    fundamentalFieldSources?: Record<string, string> | null;
    fundamental?: {
      pe_ttm?: number | null;
      pb?: number | null;
      market_cap?: number | null;
      profit_yoy?: number | null;
    };
  };
  position: {
    symbol: string;
    shares: number;
    costBasis: number;
    currentPrice: number;
    currentValue: number;
    currentWeight: number;
    unrealizedPnlPct: number | null;
  } | null;
  recommendation: {
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
    source?: "llm-live" | "llm-cache";
    dataQuality?: string[];
    constraintWarnings: string[];
  };
}

interface PortfolioContext {
  mode: PortfolioMode;
  cash: number;
  equity: number;
  maxPositions: number;
  asOf: string;
  holdingsUpdatedAt?: string;
  holdingsFileFound: boolean;
  warnings: string[];
}

interface SetupRequired {
  code: "holdings_missing";
  message: string;
  filePath: string;
}

const PHASE_LABEL: Record<Phase, string> = {
  loading: "加载行情、基本面与持仓",
  scoring: "LLM 生成目标仓位",
};

const PHASE_WEIGHT: Record<Phase, number> = {
  loading: 0.65,
  scoring: 0.35,
};

function calcPeg(pe?: number | null, profitYoyPct?: number | null) {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) return null;
  return pe / profitYoyPct;
}

function progressPct(progress: Progress | null): number {
  if (!progress) return 0;
  const current = progress.total > 0 ? progress.done / progress.total : 0;
  if (progress.phase === "loading") return Math.min(65, Math.round(current * PHASE_WEIGHT.loading * 100));
  return Math.min(100, Math.round((PHASE_WEIGHT.loading + current * PHASE_WEIGHT.scoring) * 100));
}

function formatFieldSources(sources?: Record<string, string> | null): string {
  if (!sources || Object.keys(sources).length === 0) return "—";
  return Object.entries(sources)
    .filter(([field]) => ["pe_ttm", "pb", "market_cap", "profit_yoy"].includes(field))
    .map(([field, source]) => `${field}:${source}`)
    .join("; ") || "—";
}

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSignedPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

const ACTION_LABEL: Record<PortfolioAction, string> = {
  open: "建仓",
  add: "加仓",
  hold: "持有",
  trim: "减仓",
  exit: "清仓",
  watch: "观望",
};

export default function SignalsClient() {
  const [mode, setMode] = useState<PortfolioMode>("real");
  const [paperCash, setPaperCash] = useState(1_000_000);
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioContext | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState<SetupRequired | null>(null);
  const started = useRef(false);

  function resetOutput() {
    setError(null);
    setRows([]);
    setPortfolio(null);
    setProgress(null);
    setSetupRequired(null);
  }

  function selectMode(nextMode: PortfolioMode) {
    setMode(nextMode);
    resetOutput();
  }

  function runPaperMode() {
    setMode("paper");
    void run("paper");
  }

  async function run(requestedMode = mode) {
    setLoading(true);
    resetOutput();
    try {
      const response = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: requestedMode,
          paperCash: requestedMode === "paper" ? paperCash : undefined,
        }),
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const evt = JSON.parse(line) as
            | { type: "progress"; phase: Phase; done: number; total: number }
            | { type: "result"; portfolio: PortfolioContext; rows: SignalRow[] }
            | { type: "setup_required"; code: "holdings_missing"; message: string; filePath: string }
            | { type: "error"; message: string };
          if (evt.type === "progress") {
            setProgress({ phase: evt.phase, done: evt.done, total: evt.total });
          } else if (evt.type === "result") {
            setRows(evt.rows);
            setPortfolio(evt.portfolio);
          } else if (evt.type === "setup_required") {
            setRows([]);
            setPortfolio(null);
            setSetupRequired({
              code: evt.code,
              message: evt.message,
              filePath: evt.filePath,
            });
          } else {
            setRows([]);
            setPortfolio(null);
            setError(evt.message);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run("real");
  }, []);

  const sortedRows = useMemo(() => [...rows].sort((a, b) => {
    const da = Math.abs(a.recommendation.deltaWeight);
    const db = Math.abs(b.recommendation.deltaWeight);
    if (db !== da) return db - da;
    return b.recommendation.adjustedTargetWeight - a.recommendation.adjustedTargetWeight;
  }), [rows]);
  const actionCount = useMemo(() => ({
    open: rows.filter((r) => r.recommendation.action === "open").length,
    add: rows.filter((r) => r.recommendation.action === "add").length,
    trim: rows.filter((r) => r.recommendation.action === "trim").length,
    exit: rows.filter((r) => r.recommendation.action === "exit").length,
  }), [rows]);
  const pct = progressPct(progress);

  return (
    <div className="container">
      <Link href="/" className="back-link">返回股票池</Link>
      <header className="page-header compact">
        <div>
          <div className="eyebrow">{SITE_EYEBROW}</div>
          <h1>持仓信号</h1>
          <p>LLM 输出 5-20 个交易日目标仓位；本地持仓、行情、基本面与数据质量共同进入提示词。K 线或 LLM 失败会显示信号不可用。</p>
        </div>
        <div className="header-actions">
          <button onClick={() => run()} disabled={loading}>{loading ? "运行中…" : "运行信号"}</button>
        </div>
      </header>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="field">
          <span>组合模式</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={mode === "real" ? "" : "secondary"}
              onClick={() => selectMode("real")}
              disabled={loading}
            >
              真实持仓
            </button>
            <button
              type="button"
              className={mode === "paper" ? "" : "secondary"}
              onClick={() => selectMode("paper")}
              disabled={loading}
            >
              模拟资金
            </button>
          </div>
        </div>
        {mode === "paper" && (
          <label className="field">
            <span>模拟资金</span>
            <input
              type="number"
              min={1}
              step={10000}
              value={paperCash}
              onChange={(e) => setPaperCash(Math.max(1, Number(e.target.value) || 1))}
              disabled={loading}
            />
          </label>
        )}
        <div className="toolbar-status">
          {mode === "real"
            ? "使用 web/data/holdings.local.json 计算真实当前仓位和调仓差额"
            : "使用模拟现金组合推演目标仓位，不代表真实持仓"}
        </div>
      </div>

      {(loading || progress) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>
              {progress ? PHASE_LABEL[progress.phase] : "准备中…"}
              {progress && ` ${progress.done}/${progress.total}`}
            </span>
            <span className="muted">{pct}%</span>
          </div>
          <div className="fetch-progress-track" style={{ marginTop: 8 }}>
            <div className="fetch-progress-bar" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)", marginBottom: 14 }}>
          <strong>信号不可用：</strong> {error}
        </div>
      )}

      {setupRequired && (
        <div className="card setup-card">
          <div className="setup-copy">
            <strong>先选择组合来源</strong>
            <p>{setupRequired.message}</p>
          </div>
          <div className="setup-actions">
            <button type="button" onClick={runPaperMode} disabled={loading}>
              用 {formatMoney(paperCash)} 模拟运行
            </button>
            <button type="button" className="secondary" onClick={() => run("real")} disabled={loading}>
              重新检测真实持仓
            </button>
          </div>
          <details className="setup-details">
            <summary>配置真实持仓</summary>
            <div className="setup-path">路径 <code>{setupRequired.filePath}</code></div>
            <pre>{`{
  "updated_at": "2026-05-31",
  "cash": 100000,
  "positions": [
    { "symbol": "688256", "shares": 100, "cost_basis": 120.5 }
  ]
}`}</pre>
          </details>
        </div>
      )}

      {portfolio && (
        <div className="summary-grid" style={{ marginBottom: 14 }}>
          <div className="metric">
            <span className="label">组合权益</span>
            <strong>{formatMoney(portfolio.equity)}</strong>
            <span>现金 {formatMoney(portfolio.cash)}</span>
          </div>
          <div className="metric">
            <span className="label">目标动作</span>
            <strong>{actionCount.open + actionCount.add + actionCount.trim + actionCount.exit}</strong>
            <span>建仓 {actionCount.open} · 加仓 {actionCount.add} · 减仓 {actionCount.trim} · 清仓 {actionCount.exit}</span>
          </div>
          <div className="metric">
            <span className="label">约束</span>
            <strong>{portfolio.maxPositions}</strong>
            <span>最多非零目标持仓</span>
          </div>
          <div className="metric">
            <span className="label">信号日期</span>
            <strong>{portfolio.asOf}</strong>
            <span>
              {portfolio.mode === "paper"
                ? "模拟资金"
                : portfolio.holdingsFileFound ? `持仓 ${portfolio.holdingsUpdatedAt ?? "local"}` : "真实持仓未配置"}
            </span>
          </div>
        </div>
      )}

      {portfolio?.warnings.length ? (
        <div className="card" style={{ borderColor: "var(--warn)", marginBottom: 14 }}>
          <strong>组合提示：</strong> {portfolio.warnings.join("; ")}
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="theme-panel">
          <div className="theme-title">
            <strong>目标仓位</strong>
            <span>{rows.length} 只 · 按调仓差额排序</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>主题</th>
                  <th>动作</th>
                  <th className="num">当前仓位</th>
                  <th className="num">目标仓位</th>
                  <th className="num">调仓差额</th>
                  <th className="num">差额金额</th>
                  <th className="num">浮盈亏</th>
                  <th className="num">最近收盘</th>
                  <th className="num">置信度</th>
                  <th className="num">PE(TTM)</th>
                  <th className="num">利润同比</th>
                  <th className="num">PEG</th>
                  <th>LLM来源</th>
                  <th>数据源</th>
                  <th>理由</th>
                  <th>证据</th>
                  <th>风险</th>
                  <th>失效条件</th>
                  <th>数据质量</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(({ entry, recommendation, snapshot, position }) => (
                  <tr key={entry.symbol}>
                    <td className="mono">{entry.symbol}</td>
                    <td>{entry.name}</td>
                    <td>{entry.theme}</td>
                    <td><span className={`badge action-${recommendation.action}`}>{ACTION_LABEL[recommendation.action]}</span></td>
                    <td className="num">{formatPct(position?.currentWeight)}</td>
                    <td className="num">{formatPct(recommendation.adjustedTargetWeight)}</td>
                    <td className={`num ${recommendation.deltaWeight > 0 ? "pos" : recommendation.deltaWeight < 0 ? "neg" : "muted"}`}>
                      {formatSignedPct(recommendation.deltaWeight)}
                    </td>
                    <td className={`num ${recommendation.deltaValue > 0 ? "pos" : recommendation.deltaValue < 0 ? "neg" : "muted"}`}>
                      {recommendation.deltaValue > 0 ? "+" : ""}{formatMoney(recommendation.deltaValue)}
                    </td>
                    <td className={`num ${position?.unrealizedPnlPct == null ? "muted" : position.unrealizedPnlPct >= 0 ? "pos" : "neg"}`}>
                      {position?.unrealizedPnlPct == null ? "—" : `${position.unrealizedPnlPct > 0 ? "+" : ""}${position.unrealizedPnlPct.toFixed(1)}%`}
                    </td>
                    <td className="num">{snapshot.closes.at(-1)?.toFixed(2) ?? "—"}</td>
                    <td className="num">{formatPct(recommendation.confidence, 0)}</td>
                    <td className="num">{snapshot.fundamental?.pe_ttm?.toFixed(1) ?? "—"}</td>
                    <td className="num">{snapshot.fundamental?.profit_yoy != null ? `${snapshot.fundamental.profit_yoy.toFixed(1)}%` : "—"}</td>
                    <td className="num">{calcPeg(snapshot.fundamental?.pe_ttm, snapshot.fundamental?.profit_yoy)?.toFixed(2) ?? "—"}</td>
                    <td><span className={`badge ${recommendation.source ?? ""}`}>{recommendation.source ?? "—"}</span></td>
                    <td className="muted signal-reason">
                      {[snapshot.fundamentalSource, formatFieldSources(snapshot.fundamentalFieldSources)]
                        .filter((part) => part && part !== "—")
                        .join("; ") || "—"}
                    </td>
                    <td className="muted signal-reason">{recommendation.rationale}</td>
                    <td className="muted signal-reason">{recommendation.evidence.join("; ")}</td>
                    <td className="muted signal-reason">{recommendation.risks.join("; ")}</td>
                    <td className="muted signal-reason">{recommendation.invalidation}</td>
                    <td className="muted signal-reason">
                      {[...(recommendation.dataQuality ?? []), ...(recommendation.constraintWarnings ?? []), ...(snapshot.dataErrors ?? [])].join("; ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
