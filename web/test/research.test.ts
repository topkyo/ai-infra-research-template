import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildResearchCandidates,
  formatDailyCandidatesPack,
  formatResearchPack,
  formatResearchPrompt,
  RESEARCH_WORKFLOW_VERSION,
  type ResearchRow,
} from "../lib/research";
import type { PortfolioAction } from "../lib/portfolio";

function row(
  symbol: string,
  action: PortfolioAction,
  opts: Partial<{
    theme: string;
    adjustedTargetWeight: number;
    deltaWeight: number;
    confidence: number;
    currentWeight: number;
    dataQuality: string[];
    constraintWarnings: string[];
  }> = {},
): ResearchRow {
  const theme = opts.theme ?? "光模块";
  return {
    entry: { symbol, name: `N${symbol}`, theme, global_supply: true },
    snapshot: {
      symbol,
      name: `N${symbol}`,
      theme,
      latestDate: "2026-06-01",
      closes: Array.from({ length: 30 }, (_, index) => 100 + index),
      fundamentalSource: "test",
      fundamentalFieldSources: {
        pe_ttm: "test_pe",
        pb: "test_pb",
        market_cap: "test_cap",
        profit_yoy: "test_profit",
      },
      fundamental: {
        pe_ttm: 20,
        pb: 3,
        market_cap: 1000,
        profit_yoy: 40,
      },
    },
    position: opts.currentWeight != null
      ? {
          currentWeight: opts.currentWeight,
          unrealizedPnlPct: 12.3,
        }
      : null,
    recommendation: {
      action,
      targetWeight: opts.adjustedTargetWeight ?? 0.1,
      adjustedTargetWeight: opts.adjustedTargetWeight ?? 0.1,
      deltaWeight: opts.deltaWeight ?? 0.1,
      confidence: opts.confidence ?? 0.8,
      rationale: "rationale",
      evidence: ["field evidence"],
      risks: ["known risk"],
      invalidation: "trend break",
      dataQuality: opts.dataQuality,
      constraintWarnings: opts.constraintWarnings ?? [],
    },
  };
}

test("buildResearchCandidates returns at most six candidates with explainable reasons", () => {
  const rows = Array.from({ length: 9 }, (_, index) =>
    row(`S${index}`, "open", {
      theme: index < 5 ? "光模块" : "液冷",
      adjustedTargetWeight: 0.2 - index * 0.01,
      deltaWeight: 0.2 - index * 0.01,
    }),
  );

  const candidates = buildResearchCandidates(rows);

  assert.equal(candidates.length, 6);
  assert.ok(candidates.every((candidate) => candidate.candidateReason.length > 0));
  assert.ok(candidates.some((candidate) => candidate.row.entry.theme === "液冷"));
});

test("buildResearchCandidates prioritizes open add trim and exit work over passive rows", () => {
  const candidates = buildResearchCandidates([
    row("HOLD", "hold", { adjustedTargetWeight: 0.08, deltaWeight: 0, confidence: 1 }),
    row("OPEN", "open", { adjustedTargetWeight: 0.08, deltaWeight: 0.08, confidence: 0.7 }),
    row("TRIM", "trim", { adjustedTargetWeight: 0.02, deltaWeight: -0.08, currentWeight: 0.1, confidence: 0.7 }),
  ]);

  assert.deepEqual(new Set(candidates.slice(0, 2).map((candidate) => candidate.row.entry.symbol)), new Set(["OPEN", "TRIM"]));
  assert.match(candidates.find((candidate) => candidate.row.entry.symbol === "TRIM")?.candidateReason ?? "", /减仓复核/);
});

test("balanced scoring can rank strong research value above action-only candidates", () => {
  const candidates = buildResearchCandidates([
    row("ACTION", "open", { adjustedTargetWeight: 0.01, deltaWeight: 0.01, confidence: 0.2 }),
    row("RESEARCH", "hold", { adjustedTargetWeight: 0.2, deltaWeight: 0.18, confidence: 1 }),
  ]);

  assert.equal(candidates[0].row.entry.symbol, "RESEARCH");
  assert.ok(candidates[0].score > candidates[1].score);
});

test("score breakdown total matches candidate score", () => {
  const candidate = buildResearchCandidates([
    row("SCORE", "add", { adjustedTargetWeight: 0.12, deltaWeight: 0.07, confidence: 0.8 }),
  ])[0];
  const b = candidate.scoreBreakdown;

  assert.equal(candidate.score, b.total);
  assert.equal(b.total, Number((b.action + b.delta + b.target + b.confidence + b.holdingRisk + b.dataReview - b.noTargetPenalty).toFixed(3)));
  assert.ok(b.action > 0);
  assert.ok(b.delta > 0);
  assert.ok(b.target > 0);
  assert.ok(b.confidence > 0);
});

test("data gaps are exposed in candidates and research packs", () => {
  const candidates = buildResearchCandidates([
    row("GAP", "open", {
      dataQuality: ["missing_fundamental", "missing_peg"],
      adjustedTargetWeight: 0.12,
      deltaWeight: 0.12,
    }),
  ]);
  const pack = formatResearchPack(candidates[0]);

  assert.deepEqual(candidates[0].dataGaps, ["missing_fundamental", "missing_peg"]);
  assert.match(candidates[0].candidateReason, /数据缺口需复核/);
  assert.match(pack, /missing_fundamental/);
  assert.match(pack, /候选评分:/);
  assert.match(pack, /评分拆解: 动作/);
  assert.doesNotMatch(pack, /订单已确认|客户确认|公告显示/);
});

test("portfolio constraint warnings are separate from data gaps and risk-warning classification", () => {
  const candidates = buildResearchCandidates([
    row("LIMITED", "open", {
      adjustedTargetWeight: 0.12,
      deltaWeight: 0.12,
      constraintWarnings: ["组合目标仓位合计超过 100%，已按比例压缩"],
    }),
  ]);
  const pack = formatResearchPack(candidates[0]);

  assert.equal(candidates[0].kind, "主线进攻");
  assert.deepEqual(candidates[0].dataGaps, []);
  assert.deepEqual(candidates[0].constraintWarnings, ["组合目标仓位合计超过 100%，已按比例压缩"]);
  assert.doesNotMatch(candidates[0].candidateReason, /数据缺口需复核/);
  assert.match(pack, /组合约束: 组合目标仓位合计超过 100%，已按比例压缩/);
  assert.match(pack, /数据缺口: none/);
});

test("research prompt includes workflow version and the source pack", () => {
  const candidate = buildResearchCandidates([row("P", "open")])[0];
  const prompt = formatResearchPrompt(candidate);

  assert.match(prompt, new RegExp(RESEARCH_WORKFLOW_VERSION));
  assert.match(prompt, /【输入】/);
  assert.match(prompt, /AI 基建候选研究包 - P NP/);
});

test("copied packs redact private cash equity shares and amount fields by default", () => {
  const candidates = buildResearchCandidates([row("R", "add", { currentWeight: 0.05, deltaWeight: 0.05 })]);
  const pack = formatDailyCandidatesPack(candidates);

  assert.match(pack, /private_amounts: redacted/);
  assert.doesNotMatch(pack, /cash/i);
  assert.doesNotMatch(pack, /equity/i);
  assert.doesNotMatch(pack, /shares/i);
  assert.doesNotMatch(pack, /delta amount/i);
});
