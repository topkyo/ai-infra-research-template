import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Kline } from "../lib/pyserver";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-api-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });

const universe = {
  updated_at: "2026-01-01",
  updated_by: "test",
  entries: [
    { symbol: "000001", name: "平安银行", theme: "云/AI基建" },
  ],
};
fs.writeFileSync("data/universe.json", JSON.stringify(universe, null, 2) + "\n");
fs.writeFileSync(
  "data/thesis.example.md",
  `# 主题定义（示例，可复制为 thesis.md 后修改）

本模板默认研究中国 A 股 AI 基建供给侧：跟踪算力芯片、光模块/高速互连、AI 服务器、液冷散热、电力、IDC、存储/HBM、半导体设备与材料、AI-PCB、功率半导体、晶圆代工与云。优先识别与全球 AI capex / 海外供应链相关的标的，不做多纯人类消费品。

刷池子主题命名沿用：算力/AI芯片、光模块、AI服务器、液冷、电力、IDC、功率半导体、存储/HBM、半导体设备、半导体材料、AI-PCB、晶圆代工、云/AI基建。
`,
);
fs.writeFileSync("data/holdings.local.json", JSON.stringify({
  updated_at: "2026-01-01",
  cash: 100000,
  positions: [],
}, null, 2) + "\n");

function makeKlines(start: string, count: number): Kline[] {
  const d = new Date(start);
  return Array.from({ length: count }, (_, i) => {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    const close = 100 + i;
    return { date, open: close, high: close, low: close, close, volume: 1_000_000 };
  });
}

async function readEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) events.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return events;
}

function installStrictFailureFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.deepseek.com")) {
      return new Response("bad gateway", { status: 502 });
    }
    if (url.includes("/klines")) {
      return new Response(JSON.stringify(makeKlines("2025-01-01", 40)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/benchmark/klines")) {
      return new Response(JSON.stringify(makeKlines("2025-01-01", 40)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/fundamental")) {
      return new Response(JSON.stringify({
        symbol: "000001",
        pe_ttm: 10,
        pb: 1,
        market_cap: 1000,
        profit_yoy: 20,
        source: "test",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected URL", { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installCountingFetch() {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCount++;
    const url = String(input);
    if (url.includes("api.deepseek.com") || url.includes("/klines") || url.includes("/fundamental")) {
      return new Response("should not be called", { status: 500 });
    }
    return originalFetch(input);
  }) as typeof fetch;
  return {
    get count() {
      return fetchCount;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("/api/signals emits terminal error when universe.json is missing", async () => {
  const universePath = "data/universe.json";
  const saved = fs.readFileSync(universePath, "utf-8");
  fs.unlinkSync(universePath);
  const counter = installCountingFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/signals/route");
    const events = await readEvents(await POST(new NextRequest("http://test/api/signals", { method: "POST" })));
    assert.equal(events[0]?.type, "error");
    assert.match(String(events[0]?.message), /universe\.example\.json/);
    assert.equal(counter.count, 0);
    assert.equal(events.some((event) => event.type === "result"), false);
  } finally {
    counter.restore();
    fs.writeFileSync(universePath, saved);
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("/api/signals emits terminal error when LLM scoring fails", async () => {
  const restore = installStrictFailureFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/signals/route");
    const events = await readEvents(await POST(new NextRequest("http://test/api/signals", { method: "POST" })));
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /deepseek 502/);
    assert.equal(events.some((event) => event.type === "result"), false);
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("/api/backtest emits terminal error and stores no result when LLM scoring fails", async () => {
  const restore = installStrictFailureFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/backtest/route");
    const { listBacktestResults } = await import("../lib/cache");
    const response = await POST(new NextRequest("http://test/api/backtest", {
      method: "POST",
      body: JSON.stringify({
        startDate: "2025-01-20",
        endDate: "2025-02-28",
        rebalanceEveryNDays: 100,
        maxPositions: 1,
      }),
    }));
    const events = await readEvents(response);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /deepseek 502/);
    assert.equal(events.some((event) => event.type === "result"), false);
    assert.equal(listBacktestResults().length, 0);
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("/api/universe/refresh emits terminal error and leaves file unchanged when LLM fails", async () => {
  const before = fs.readFileSync("data/universe.json", "utf-8");
  const restore = installStrictFailureFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/universe/refresh/route");
    const events = await readEvents(await POST());
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /deepseek 502/);
    assert.equal(fs.readFileSync("data/universe.json", "utf-8"), before);
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("/api/universe/refresh refuses explicitly on read-only deployments", async () => {
  const before = fs.readFileSync("data/universe.json", "utf-8");
  process.env.UNIVERSE_REFRESH_ENABLED = "0";
  try {
    const { POST } = await import("../app/api/universe/refresh/route");
    const events = await readEvents(await POST());
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /只读股票池/);
    // The gate fires before any LLM/market call: no log progress, no result.
    assert.equal(events.some((event) => event.type === "result"), false);
    assert.equal(fs.readFileSync("data/universe.json", "utf-8"), before);
  } finally {
    delete process.env.UNIVERSE_REFRESH_ENABLED;
  }
});
