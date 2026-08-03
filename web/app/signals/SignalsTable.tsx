"use client";

import { useMemo } from "react";
import type { SignalRow } from "./useSignalStream";
import {
  ACTION_LABEL,
  calcPeg,
  formatFieldSources,
  formatMoney,
  formatPct,
  formatSignedPct,
} from "./format";

export default function SignalsTable({ rows }: { rows: SignalRow[] }) {
  const sortedRows = useMemo(() => [...rows].sort((a, b) => {
    const da = Math.abs(a.recommendation.deltaWeight);
    const db = Math.abs(b.recommendation.deltaWeight);
    if (db !== da) return db - da;
    return b.recommendation.adjustedTargetWeight - a.recommendation.adjustedTargetWeight;
  }), [rows]);

  if (rows.length === 0) return null;

  return (
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
              <th>组合约束</th>
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
                <td>
                  {/* llm-mock is offline test output: warn styling (reuses the
                      unscorable badge variant) so it never reads as live LLM. */}
                  <span className={`badge ${recommendation.source === "llm-mock" ? "unscorable" : recommendation.source ?? ""}`}>
                    {recommendation.source ?? "—"}
                  </span>
                </td>
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
                  {[...(recommendation.dataQuality ?? []), ...(snapshot.dataErrors ?? [])].join("; ") || "—"}
                </td>
                <td className="muted signal-reason">
                  {recommendation.constraintWarnings.join("; ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
