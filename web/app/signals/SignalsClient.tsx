"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SITE_EYEBROW } from "@/lib/site";
import HoldingsSetup from "./HoldingsSetup";
import ResearchPanel from "./ResearchPanel";
import SignalsTable from "./SignalsTable";
import { formatMoney } from "./format";
import {
  useSignalStream,
  type Phase,
  type PortfolioMode,
  type Progress,
} from "./useSignalStream";

const PHASE_LABEL: Record<Phase, string> = {
  loading: "加载行情、基本面与持仓",
  scoring: "LLM 生成目标仓位",
};

const PHASE_WEIGHT: Record<Phase, number> = {
  loading: 0.65,
  scoring: 0.35,
};

function progressPct(progress: Progress | null): number {
  if (!progress) return 0;
  const current = progress.total > 0 ? progress.done / progress.total : 0;
  if (progress.phase === "loading") return Math.min(65, Math.round(current * PHASE_WEIGHT.loading * 100));
  return Math.min(100, Math.round((PHASE_WEIGHT.loading + current * PHASE_WEIGHT.scoring) * 100));
}

export default function SignalsClient() {
  const [mode, setMode] = useState<PortfolioMode>("real");
  const [paperCash, setPaperCash] = useState(1_000_000);
  const {
    rows,
    portfolio,
    progress,
    loading,
    error,
    setupRequired,
    notices,
    setError,
    setSetupRequired,
    run,
    resetOutput,
  } = useSignalStream({ mode, paperCash });
  const started = useRef(false);

  function selectMode(nextMode: PortfolioMode) {
    setMode(nextMode);
    resetOutput();
    void run(nextMode);
  }

  async function handleHoldingsSaved() {
    setSetupRequired(null);
    setMode("real");
    await run("real");
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run("real");
  }, [run]);

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

      {notices.length > 0 && (
        <div className="card" style={{ borderColor: "var(--warn)", marginBottom: 14, fontSize: 12 }}>
          {notices.map((n, i) => <div key={i}>· {n}</div>)}
        </div>
      )}

      {setupRequired && (
        <HoldingsSetup
          setupRequired={setupRequired}
          loading={loading}
          paperCash={paperCash}
          onClearError={() => setError(null)}
          onSaved={handleHoldingsSaved}
          onRetryReal={() => { void run("real"); }}
          onRunPaper={() => selectMode("paper")}
        />
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

      <ResearchPanel rows={rows} />

      <SignalsTable rows={rows} />
    </div>
  );
}
