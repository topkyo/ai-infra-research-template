import { test, expect } from "@playwright/test";

// Full-pipeline flows: LLM_PROVIDER=mock (deterministic offline signals) +
// mock pyserver exercise scoring, portfolio rules, and the backtest engine
// end to end without network access.

test("signals paper mode produces target weights end-to-end", async ({ page }) => {
  await page.goto("/signals");
  await expect(page.getByRole("heading", { name: "持仓信号" })).toBeVisible();
  // Confirm the client has hydrated: the real-mode auto-run drives a
  // client-only state change (loading indicator, setup card, or results).
  // The mode buttons are disabled while loading, so we click 模拟资金 the
  // moment hydration is proven — right after the initial run releases the
  // buttons — exercising the AbortController path: the prior run token is
  // superseded and any stale events are ignored.
  await expect(
    page
      .getByText("运行中…")
      .or(page.getByText("配置真实持仓"))
      .or(page.getByText("信号日期")),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "模拟资金" }).click();
  await expect(page.getByLabel("模拟资金")).toBeVisible();
  // Result: KPI block + target-weight table with rows.
  await expect(page.getByText("信号日期")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("columnheader", { name: "目标仓位" })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
});

test("backtest runs to an equity curve with mock LLM", async ({ page }) => {
  // Use relative dates so the test never goes stale. The mock pyserver
  // generates synthetic klines for any date range, so we pick a recent
  // ~6-week window ending today.
  const today = new Date();
  const start = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);
  // Align start to the most recent weekday (mock klines skip weekends).
  while (start.getDay() === 0 || start.getDay() === 6) {
    start.setDate(start.getDate() - 1);
  }
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  await page.goto("/backtest");
  await page.getByLabel("起始").fill(fmt(start));
  await page.getByLabel("结束").fill(fmt(today));
  await page.getByLabel("调仓周期").fill("5");
  await page.getByRole("button", { name: "运行回测" }).click();
  // Result: KPI cards + rendered recharts equity curve.
  await expect(page.getByText("总收益")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "权益曲线" })).toBeVisible();
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
});
