import { test, expect } from "@playwright/test";

// Smoke suite: page shells render, mock-pyserver data flows into the table,
// and the signals page exposes setup_required instead of calling the LLM when
// holdings are missing (fresh checkout has no holdings.local.json).

test("home renders the universe table and loads mock prices", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "topkyo · AI 基建研究台" })).toBeVisible();
  // Universe table renders grouped theme panels with stock codes.
  await expect(page.getByRole("columnheader", { name: "代码" }).first()).toBeVisible();
  await expect(page.getByText("688256").first()).toBeVisible();
  // Mock pyserver fills spot/analyst data progressively until completion.
  await expect(page.getByText("pyserver 数据加载完成")).toBeVisible({ timeout: 60_000 });
});

test("backtest page renders the full parameter form", async ({ page }) => {
  await page.goto("/backtest");
  await expect(page.getByRole("heading", { name: "策略回测" })).toBeVisible();
  for (const label of ["起始", "结束", "调仓周期", "最大持仓数", "初始资金", "费率(bps)", "滑点(bps)", "基准指数", "涨跌停限制"]) {
    await expect(page.getByText(label).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "运行回测" })).toBeEnabled();
});

test("signals page surfaces setup_required when holdings are missing", async ({ page }) => {
  await page.goto("/signals");
  await expect(page.getByRole("heading", { name: "持仓信号" })).toBeVisible();
  // The API returns setup_required before any market/LLM call; the UI shows
  // the holdings setup card rather than fabricating signals.
  await expect(page.getByText("粘贴持仓明细")).toBeVisible({ timeout: 60_000 });
});
