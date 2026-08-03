import { test, expect } from "@playwright/test";

// Full-pipeline flows: LLM_PROVIDER=mock (deterministic offline signals) +
// mock pyserver exercise scoring, portfolio rules, and the backtest engine
// end to end without network access.

test("signals paper mode produces target weights end-to-end", async ({ page }) => {
  await page.goto("/signals");
  await expect(page.getByRole("heading", { name: "持仓信号" })).toBeVisible();
  // Let the initial real-mode auto-run settle first: setup card on a fresh
  // checkout, or results when a local holdings file exists.
  await expect(
    page.getByText("配置真实持仓").or(page.getByText("信号日期")),
  ).toBeVisible({ timeout: 60_000 });
  // Switch to paper mode and confirm the switch landed (paper cash field only
  // renders in paper mode). The mode switch starts the run automatically —
  // clicking 运行信号 here would trigger a second run.
  await page.getByRole("button", { name: "模拟资金" }).click();
  await expect(page.getByLabel("模拟资金")).toBeVisible();
  // Result: KPI block + target-weight table with rows.
  await expect(page.getByText("信号日期")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("columnheader", { name: "目标仓位" })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
});

test("backtest runs to an equity curve with mock LLM", async ({ page }) => {
  await page.goto("/backtest");
  await page.getByLabel("起始").fill("2026-06-01");
  await page.getByLabel("结束").fill("2026-07-15");
  await page.getByLabel("调仓周期").fill("5");
  await page.getByRole("button", { name: "运行回测" }).click();
  // Result: KPI cards + rendered recharts equity curve.
  await expect(page.getByText("总收益")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "权益曲线" })).toBeVisible();
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
});
