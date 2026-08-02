"use client";

import { useMemo, useState } from "react";
import {
  buildResearchCandidates,
  formatDailyCandidatesPack,
  formatResearchPack,
  formatResearchPrompt,
} from "@/lib/research";
import type { ResearchCandidate } from "@/lib/research";
import type { SignalRow } from "./useSignalStream";
import { ACTION_LABEL, formatPct, formatSignedPct } from "./format";

function formatResearchScore(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatResearchScoreSummary(candidate: ResearchCandidate): string {
  const breakdown = candidate.scoreBreakdown;
  return [
    `评分 ${formatResearchScore(candidate.score)}`,
    `动作${formatResearchScore(breakdown.action)}`,
    `变化${formatResearchScore(breakdown.delta)}`,
    `目标${formatResearchScore(breakdown.target)}`,
    `置信${formatResearchScore(breakdown.confidence)}`,
  ].join(" · ");
}

export default function ResearchPanel({ rows }: { rows: SignalRow[] }) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const researchCandidates = useMemo(() => buildResearchCandidates(rows), [rows]);

  async function copyText(label: string, text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!ok) throw new Error("copy command failed");
      }
      setCopyStatus(`${label}已复制`);
      window.setTimeout(() => setCopyStatus(null), 1800);
    } catch (e) {
      setCopyStatus(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (researchCandidates.length === 0) return null;

  return (
    <div className="research-panel">
      <div className="theme-title">
        <div>
          <strong>今日研究候选</strong>
          <span>{researchCandidates.length} 只 · 复制到 LLM / 炼丹炉深聊</span>
        </div>
        <div className="research-actions">
          {copyStatus && <span className={copyStatus.startsWith("复制失败") ? "neg" : "pos"}>{copyStatus}</span>}
          <button
            type="button"
            className="secondary"
            onClick={() => copyText("今日候选包", formatDailyCandidatesPack(researchCandidates))}
          >
            复制今日候选包
          </button>
        </div>
      </div>
      <div className="research-grid">
        {researchCandidates.map((candidate) => {
          const { row } = candidate;
          const recommendation = row.recommendation;
          const risk = recommendation.risks[0] ?? "—";
          const gaps = candidate.dataGaps.slice(0, 2);
          const constraints = candidate.constraintWarnings.slice(0, 2);
          return (
            <article className="research-card" key={row.entry.symbol}>
              <div className="research-card-head">
                <div>
                  <div className="mono">{row.entry.symbol}</div>
                  <strong>{row.entry.name}</strong>
                </div>
                <span className={`badge action-${recommendation.action}`}>{ACTION_LABEL[recommendation.action]}</span>
              </div>
              <div className="research-meta">
                <span>{candidate.kind}</span>
                <span>{row.entry.theme}</span>
                <span>置信 {formatPct(recommendation.confidence, 0)}</span>
              </div>
              <div className="research-metrics">
                <div>
                  <span>目标</span>
                  <strong>{formatPct(recommendation.adjustedTargetWeight)}</strong>
                </div>
                <div>
                  <span>变化</span>
                  <strong className={recommendation.deltaWeight > 0 ? "pos" : recommendation.deltaWeight < 0 ? "neg" : ""}>
                    {formatSignedPct(recommendation.deltaWeight)}
                  </strong>
                </div>
              </div>
              <p className="research-reason">{candidate.candidateReason}</p>
              <p className="research-score">{formatResearchScoreSummary(candidate)}</p>
              <p className="research-line"><span>风险</span>{risk}</p>
              <p className="research-line"><span>数据</span>{gaps.length ? gaps.join("; ") : "无明显缺口"}</p>
              {constraints.length > 0 && (
                <p className="research-line"><span>约束</span>{constraints.join("; ")}</p>
              )}
              <div className="research-card-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => copyText(`${row.entry.symbol}研究包`, formatResearchPack(candidate))}
                >
                  复制研究包
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => copyText(`${row.entry.symbol}Prompt`, formatResearchPrompt(candidate))}
                >
                  复制 Prompt
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
