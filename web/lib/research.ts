import type { PortfolioAction } from "./portfolio";
import type { UniverseEntry } from "./universe";

export const RESEARCH_WORKFLOW_VERSION = "research-workflow-v1";

export interface ResearchRow {
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
    currentWeight: number;
    unrealizedPnlPct: number | null;
  } | null;
  recommendation: {
    action: PortfolioAction;
    targetWeight: number;
    adjustedTargetWeight: number;
    deltaWeight: number;
    confidence: number;
    rationale: string;
    evidence: string[];
    risks: string[];
    invalidation: string;
    dataQuality?: string[];
    constraintWarnings?: string[];
  };
}

export type ResearchCandidateKind = "主线进攻" | "持仓复核" | "风险预警" | "反向观察";

export interface ResearchCandidate {
  row: ResearchRow;
  kind: ResearchCandidateKind;
  score: number;
  candidateReason: string;
  dataGaps: string[];
  constraintWarnings: string[];
}

export interface ResearchCopyOptions {
  includePrivateAmounts?: boolean;
}

const MAX_CANDIDATES = 6;
const MAX_PER_THEME = 2;

function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  return `${(value * 100).toFixed(digits)}%`;
}

function signedPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  const n = value * 100;
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function numberOrUnavailable(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function calcPeg(pe?: number | null, profitYoyPct?: number | null): number | null {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) return null;
  return pe / profitYoyPct;
}

function dataGapsFor(row: ResearchRow): string[] {
  const gaps = [
    ...(row.recommendation.dataQuality ?? []),
    ...(row.snapshot.dataErrors ?? []),
  ];
  return [...new Set(gaps)].slice(0, 6);
}

function constraintWarningsFor(row: ResearchRow): string[] {
  return [...new Set(row.recommendation.constraintWarnings ?? [])].slice(0, 6);
}

function actionBaseScore(action: PortfolioAction): number {
  switch (action) {
    case "open":
      return 100;
    case "add":
      return 90;
    case "exit":
      return 88;
    case "trim":
      return 84;
    case "hold":
      return 35;
    case "watch":
      return 20;
  }
}

function candidateKind(row: ResearchRow, dataGaps: string[]): ResearchCandidateKind {
  const action = row.recommendation.action;
  if ((action === "trim" || action === "exit") && row.position) return "持仓复核";
  if (dataGaps.length > 0 && row.recommendation.adjustedTargetWeight > 0) return "风险预警";
  if (action === "watch" || action === "hold") return "反向观察";
  return "主线进攻";
}

function candidateReason(row: ResearchRow, dataGaps: string[]): string {
  const action = row.recommendation.action;
  const absDelta = Math.abs(row.recommendation.deltaWeight);
  const reasons: string[] = [];
  if (action === "open") reasons.push("新开仓");
  if (action === "add") reasons.push(absDelta >= 0.05 ? "加仓变化大" : "加仓复核");
  if (action === "trim") reasons.push("持仓需减仓复核");
  if (action === "exit") reasons.push("持仓需清仓复核");
  if (action === "hold" && row.position) reasons.push("持仓继续占用仓位");
  if (action === "watch" && row.recommendation.confidence >= 0.65) reasons.push("高置信观察");
  if (row.recommendation.adjustedTargetWeight >= 0.12) reasons.push("目标权重靠前");
  if (dataGaps.length > 0) reasons.push("数据缺口需复核");
  if (reasons.length === 0) reasons.push("候选排序靠前");
  return [...new Set(reasons)].slice(0, 3).join(" / ");
}

function candidateScore(row: ResearchRow, dataGaps: string[]): number {
  const recommendation = row.recommendation;
  const action = recommendation.action;
  const actionScore = actionBaseScore(action);
  const deltaScore = Math.min(Math.abs(recommendation.deltaWeight), 0.25) * 240;
  const targetScore = Math.min(recommendation.adjustedTargetWeight, 0.25) * 160;
  const confidenceScore = recommendation.confidence * 30;
  const holdingRiskScore = row.position && (action === "trim" || action === "exit") ? 28 : 0;
  const dataReviewScore = dataGaps.length > 0 && recommendation.adjustedTargetWeight > 0 ? 12 : 0;
  const noTargetPenalty = recommendation.adjustedTargetWeight <= 0 && !row.position ? 45 : 0;
  return actionScore + deltaScore + targetScore + confidenceScore + holdingRiskScore + dataReviewScore - noTargetPenalty;
}

export function buildResearchCandidates(
  rows: ResearchRow[],
  opts: { max?: number } = {},
): ResearchCandidate[] {
  const max = Math.max(1, Math.min(opts.max ?? MAX_CANDIDATES, MAX_CANDIDATES));
  const ranked = rows
    .map((row) => {
      const dataGaps = dataGapsFor(row);
      const constraintWarnings = constraintWarningsFor(row);
      return {
        row,
        dataGaps,
        constraintWarnings,
        kind: candidateKind(row, dataGaps),
        candidateReason: candidateReason(row, dataGaps),
        score: candidateScore(row, dataGaps),
      };
    })
    .filter((candidate) =>
      candidate.row.recommendation.action !== "watch"
      || candidate.row.recommendation.adjustedTargetWeight > 0
      || candidate.row.position,
    )
    .sort((a, b) => b.score - a.score);

  const selected: ResearchCandidate[] = [];
  const perTheme = new Map<string, number>();
  for (const candidate of ranked) {
    if (selected.length >= max) break;
    const theme = candidate.row.entry.theme;
    const count = perTheme.get(theme) ?? 0;
    if (count >= MAX_PER_THEME && ranked.length - selected.length > max - selected.length) continue;
    selected.push(candidate);
    perTheme.set(theme, count + 1);
  }

  for (const candidate of ranked) {
    if (selected.length >= max) break;
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
  }

  return selected;
}

function fieldSources(row: ResearchRow): string {
  const sources = row.snapshot.fundamentalFieldSources;
  if (!sources || Object.keys(sources).length === 0) return "unavailable";
  return Object.entries(sources)
    .filter(([field]) => ["pe_ttm", "pb", "market_cap", "profit_yoy"].includes(field))
    .map(([field, source]) => `${field}:${source}`)
    .join("; ") || "unavailable";
}

export function formatResearchPack(
  candidate: ResearchCandidate,
  opts: ResearchCopyOptions = {},
): string {
  const row = candidate.row;
  const fund = row.snapshot.fundamental;
  const peg = calcPeg(fund?.pe_ttm, fund?.profit_yoy);
  const closesTail30 = row.snapshot.closes.slice(-30).map((value) => Number(value.toFixed(3)));
  const privateNote = opts.includePrivateAmounts
    ? "private_amounts: included"
    : "private_amounts: redacted; monetary and position-size fields intentionally omitted";
  return [
    `# AI 基建候选研究包 - ${row.entry.symbol} ${row.entry.name}`,
    "",
    `workflow_version: ${RESEARCH_WORKFLOW_VERSION}`,
    privateNote,
    `as_of: ${row.snapshot.latestDate ?? "unavailable"}`,
    "",
    "## 候选定位",
    `- 分类: ${candidate.kind}`,
    `- 入选理由: ${candidate.candidateReason}`,
    `- 主题: ${row.entry.theme}`,
    `- 全球供应链: ${row.entry.global_supply ? "yes" : "no"}`,
    "",
    "## 项目信号",
    `- 动作: ${row.recommendation.action}`,
    `- 当前权重: ${pct(row.position?.currentWeight)}`,
    `- LLM 原始目标权重: ${pct(row.recommendation.targetWeight)}`,
    `- 约束后目标权重: ${pct(row.recommendation.adjustedTargetWeight)}`,
    `- 权重变化: ${signedPct(row.recommendation.deltaWeight)}`,
    `- 置信度: ${pct(row.recommendation.confidence, 0)}`,
    `- 浮盈亏: ${row.position ? `${numberOrUnavailable(row.position.unrealizedPnlPct, 1)}%` : "not held"}`,
    `- 理由: ${row.recommendation.rationale || "unavailable"}`,
    `- 证据: ${row.recommendation.evidence.join("; ") || "unavailable"}`,
    `- 风险: ${row.recommendation.risks.join("; ") || "unavailable"}`,
    `- 失效条件: ${row.recommendation.invalidation || "unavailable"}`,
    `- 组合约束: ${candidate.constraintWarnings.join("; ") || "none"}`,
    "",
    "## 数据状态",
    `- PE(TTM): ${numberOrUnavailable(fund?.pe_ttm, 1)}`,
    `- PB: ${numberOrUnavailable(fund?.pb, 2)}`,
    `- 市值(亿): ${numberOrUnavailable(fund?.market_cap, 1)}`,
    `- 利润同比: ${fund?.profit_yoy == null ? "unavailable" : `${numberOrUnavailable(fund.profit_yoy, 1)}%`}`,
    `- PEG: ${numberOrUnavailable(peg, 2)}`,
    `- 近30日收盘: ${closesTail30.length ? closesTail30.join(", ") : "unavailable"}`,
    `- 基本面来源: ${row.snapshot.fundamentalSource ?? "unavailable"}`,
    `- 字段来源: ${fieldSources(row)}`,
    `- 数据缺口: ${candidate.dataGaps.join("; ") || "none"}`,
    "",
    "## 待人工补充",
    "- 最近公告",
    "- 财报摘要",
    "- 订单 / 客户 / 产能",
    "- 解禁 / 减持 / 问询函",
    "- 产业链价格",
    "- 券商研报原文摘录",
  ].join("\n");
}

export function formatResearchPrompt(
  candidate: ResearchCandidate,
  opts: ResearchCopyOptions = {},
): string {
  return [
    "你是一组中国 A 股 AI 基建研究员，不是交易下单系统。请基于我提供的数据做研究复核，不要编造任何未给出的公告、订单、客户或研报内容。",
    "",
    `workflow_version: ${RESEARCH_WORKFLOW_VERSION}`,
    "",
    "目标：判断该标的是否进入今日 5-6 只深度研究候选，并明确需要人工补证的关键问题。",
    "",
    "请按四个角色分别输出：",
    "",
    "1. 多头分析师",
    "- 最强的 3 条支持证据。",
    "- 这些证据分别来自输入中的哪个字段或材料。",
    "- 如果证据不足，明确写“证据不足”。",
    "",
    "2. 空头分析师",
    "- 最强的 3 条反证或风险。",
    "- 哪一条最可能推翻多头假设。",
    "- 需要查哪些公告、财报或产业链数据来验证。",
    "",
    "3. 风控经理",
    "- 当前信号更像进攻、持有复核、减仓复核还是风险预警。",
    "- 若进入研究队列，建议的人工观察点和失效条件。",
    "- 不输出可直接执行的交易指令。",
    "",
    "4. 数据审计员",
    "- 列出缺失字段、非实时数据、来源不可靠或口径可能错配的地方。",
    "- 标记哪些结论不能在当前数据下成立。",
    "",
    "最后给一个结构化结论：",
    "- 研究等级：重点研究 / 观察 / 风险预警 / 暂不跟踪",
    "- 核心假设：最多 3 条",
    "- 关键反证：最多 3 条",
    "- 必查材料：最多 5 项",
    "- 今日下一步：查资料 / 等公告 / 加入观察 / 人工估值 / 暂时放弃",
    "",
    "【输入】",
    formatResearchPack(candidate, opts),
  ].join("\n");
}

export function formatDailyCandidatesPack(
  candidates: ResearchCandidate[],
  opts: ResearchCopyOptions = {},
): string {
  return [
    "# 今日 AI 基建研究候选",
    "",
    `workflow_version: ${RESEARCH_WORKFLOW_VERSION}`,
    opts.includePrivateAmounts
      ? "private_amounts: included"
      : "private_amounts: redacted; monetary and position-size fields intentionally omitted",
    "",
    ...candidates.flatMap((candidate, index) => [
      `## ${index + 1}. ${candidate.row.entry.symbol} ${candidate.row.entry.name}`,
      "",
      formatResearchPack(candidate, opts),
      "",
    ]),
  ].join("\n");
}
