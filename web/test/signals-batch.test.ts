import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Kline } from "../lib/pyserver";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-signals-batch-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });

const universe = {
  updated_at: "2026-01-01",
  updated_by: "test",
  entries: [
    { symbol: "000001", name: "平安银行", theme: "云/AI基建" },
    { symbol: "000002", name: "万科A", theme: "云/AI基建" },
    { symbol: "000003", name: "测试C", theme: "光模块" },
  ],
};
fs.writeFileSync("data/universe.json", JSON.stringify(universe, null, 2) + "\n");

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

function installBatchedSuccessFetch() {
  const originalFetch = globalThis.fetch;
  let llmCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.deepseek.com") || url.includes("/chat/completions")) {
      llmCalls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { role: string; content: string }[];
      };
      const userMsg = body.messages?.find((m) => m.role === "user")?.content ?? "{}";
      const payload = JSON.parse(userMsg) as { symbols?: { symbol: string }[] };
      const symbols = (payload.symbols ?? []).map((s) => s.symbol);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              signals: symbols.map((symbol) => ({
                symbol,
                action: "hold",
                confidence: 0.5,
                size: 0,
                rationale: "ok",
              })),
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/klines")) {
      return new Response(JSON.stringify(makeKlines("2025-01-01", 40)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/fundamental")) {
      const symbol = new URL(url, "http://localhost").searchParams.get("symbol") ?? "000001";
      return new Response(JSON.stringify({
        symbol,
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
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getLlmCalls: () => llmCalls,
  };
}

test("/api/signals uses batched LLM scoring when SIGNALS_LLM_SCORE_BATCH_SIZE is set", async () => {
  const { restore, getLlmCalls } = installBatchedSuccessFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  process.env.SIGNALS_LLM_SCORE_BATCH_SIZE = "2";
  try {
    const { POST } = await import("../app/api/signals/route");
    const events = await readEvents(await POST(new NextRequest("http://test/api/signals", { method: "POST" })));
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "result");
    assert.equal(getLlmCalls(), 2, "expected ceil(3/2) LLM calls");
    const scoring = events.filter((e) => e.type === "progress" && e.phase === "scoring");
    assert.ok(scoring.some((e) => e.done === 2 && e.total === 3));
    assert.ok(scoring.some((e) => e.done === 3 && e.total === 3));
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SIGNALS_LLM_SCORE_BATCH_SIZE;
  }
});
