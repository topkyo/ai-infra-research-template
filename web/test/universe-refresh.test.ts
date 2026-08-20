import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UniverseFile } from "../lib/universe";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-refresh-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(
  "data/thesis.example.md",
  `# 主题定义（示例，可复制为 thesis.md 后修改）

本模板默认研究中国 A 股 AI 基建供给侧：跟踪算力芯片、光模块/高速互连、AI 服务器、液冷散热、电力、IDC、存储/HBM、半导体设备与材料、AI-PCB、功率半导体、晶圆代工与云。优先识别与全球 AI capex / 海外供应链相关的标的，不做多纯人类消费品。

刷池子主题命名沿用：算力/AI芯片、光模块、AI服务器、液冷、电力、IDC、功率半导体、存储/HBM、半导体设备、半导体材料、AI-PCB、晶圆代工、云/AI基建。
`,
);

const baseUniverse: UniverseFile = {
  updated_at: "2026-01-01",
  updated_by: "test",
  entries: [
    { symbol: "000001", name: "平安银行", theme: "云/AI基建" },
  ],
};

function writeBase() {
  fs.writeFileSync("data/universe.json", JSON.stringify(baseUniverse, null, 2) + "\n");
}

function readRaw() {
  return fs.readFileSync("data/universe.json", "utf-8");
}

test("refreshUniverse propagates LLM failures and leaves universe file unchanged", async () => {
  writeBase();
  const before = readRaw();
  const { refreshUniverse } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(() => refreshUniverse(), /deepseek 502/);
    assert.equal(readRaw(), before);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("applyRefresh accepts an empty proposal without updating updated_at or writing the file", async () => {
  writeBase();
  const before = readRaw();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const result = await applyRefresh(baseUniverse, {
    adds: [],
    removes: [],
    reclassifies: [],
    rationale: "无变更",
  });
  assert.equal(result.finalCount, 1);
  assert.equal(result.applied.added.length, 0);
  assert.equal(readRaw(), before);
  const onDisk = JSON.parse(readRaw()) as UniverseFile;
  assert.equal(onDisk.updated_at, baseUniverse.updated_at);
  assert.equal(onDisk.updated_by, baseUniverse.updated_by);
});

test("applyRefresh rejects invalid adds without writing a no-change universe", async () => {
  writeBase();
  const before = readRaw();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  try {
    const result = await applyRefresh(baseUniverse, {
      adds: [{ symbol: "300002", name: "测试新增", theme: "AI-PCB" }],
      removes: [],
      reclassifies: [],
      rationale: "测试新增",
    });
    assert.deepEqual(result.applied.added, []);
    assert.equal(result.applied.rejected[0].symbol, "300002");
    assert.equal(readRaw(), before);
    const onDisk = JSON.parse(readRaw()) as UniverseFile;
    assert.equal(onDisk.updated_at, baseUniverse.updated_at);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyRefresh writes only when a real add remove or reclassify is applied", async () => {
  writeBase();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ symbol: "300003" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const result = await applyRefresh(baseUniverse, {
      adds: [{ symbol: "300003", name: "测试新增", theme: "AI-PCB" }],
      removes: [],
      reclassifies: [],
      rationale: "测试新增",
    });
    const next = JSON.parse(readRaw()) as UniverseFile;
    assert.equal(result.applied.added.length, 1);
    assert.equal(next.entries.length, 2);
    assert.notEqual(next.updated_at, baseUniverse.updated_at);
    assert.equal(next.updated_by, "deepseek-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyRefresh rejects a refresh that would persist an empty universe", async () => {
  writeBase();
  const before = readRaw();
  const { applyRefresh } = await import("../lib/universe-refresh");
  await assert.rejects(
    () => applyRefresh(baseUniverse, {
      adds: [],
      removes: ["000001"],
      reclassifies: [],
      rationale: "剔除最后一只",
    }),
    /空/,
  );
  assert.equal(readRaw(), before);
});

test("applyRefresh bumps updated_at when a symbol is removed", async () => {
  const two: UniverseFile = {
    ...baseUniverse,
    entries: [
      ...baseUniverse.entries,
      { symbol: "000002", name: "万科A", theme: "光模块" },
    ],
  };
  fs.writeFileSync("data/universe.json", JSON.stringify(two, null, 2) + "\n");
  const { applyRefresh } = await import("../lib/universe-refresh");
  const result = await applyRefresh(two, {
    adds: [],
    removes: ["000001"],
    reclassifies: [],
    rationale: "剔除",
  });
  const next = JSON.parse(readRaw()) as UniverseFile;
  assert.deepEqual(result.applied.removed, ["000001"]);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].symbol, "000002");
  assert.notEqual(next.updated_at, two.updated_at);
  assert.equal(next.updated_by, "deepseek-refresh");
});

test("applyRefresh bumps updated_at when a symbol is reclassified", async () => {
  writeBase();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const result = await applyRefresh(baseUniverse, {
    adds: [],
    removes: [],
    reclassifies: [{ symbol: "000001", theme: "AI-PCB" }],
    rationale: "改类",
  });
  const next = JSON.parse(readRaw()) as UniverseFile;
  assert.equal(result.applied.reclassified.length, 1);
  assert.equal(result.applied.reclassified[0].from, "云/AI基建");
  assert.equal(result.applied.reclassified[0].to, "AI-PCB");
  assert.equal(next.entries[0].theme, "AI-PCB");
  assert.notEqual(next.updated_at, baseUniverse.updated_at);
  assert.equal(next.updated_by, "deepseek-refresh");
});

test("validateRefreshProposal accepts an empty object as a no-op proposal", async () => {
  const { validateRefreshProposal } = await import("../lib/universe-refresh");
  assert.deepEqual(validateRefreshProposal({}), {
    adds: [],
    removes: [],
    reclassifies: [],
    rationale: "",
  });
});

test("validateRefreshProposal accepts a well-formed proposal", async () => {
  const { validateRefreshProposal } = await import("../lib/universe-refresh");
  const proposal = validateRefreshProposal({
    adds: [{ symbol: "300476", name: "胜宏科技", theme: "AI-PCB", note: "龙头", global_supply: true }],
    removes: ["000001"],
    reclassifies: [{ symbol: "600000", theme: "算力/AI芯片" }],
    rationale: "补齐 AI-PCB",
  });
  assert.equal(proposal.adds.length, 1);
  assert.equal(proposal.adds[0].global_supply, true);
  assert.deepEqual(proposal.removes, ["000001"]);
  assert.equal(proposal.reclassifies[0].theme, "算力/AI芯片");
  assert.equal(proposal.rationale, "补齐 AI-PCB");
});

test("validateRefreshProposal rejects non-object top-level values", async () => {
  const { validateRefreshProposal } = await import("../lib/universe-refresh");
  for (const bad of [null, "string", 42, []]) {
    assert.throws(
      () => validateRefreshProposal(bad),
      /universe refresh proposal must be a JSON object/,
    );
  }
});

test("validateRefreshProposal rejects malformed adds", async () => {
  const { validateRefreshProposal } = await import("../lib/universe-refresh");
  assert.throws(
    () => validateRefreshProposal({ adds: "not-array" }),
    /adds must be an array/,
  );
  assert.throws(
    () => validateRefreshProposal({ adds: [null] }),
    /adds\[0\] must be an object/,
  );
  assert.throws(
    () => validateRefreshProposal({ adds: [{ name: "x", theme: "y" }] }),
    /adds\[0\]\.symbol must be a non-empty string/,
  );
  assert.throws(
    () => validateRefreshProposal({ adds: [{ symbol: "300476", theme: "AI-PCB" }] }),
    /adds\[0\]\.name must be a non-empty string/,
  );
  assert.throws(
    () => validateRefreshProposal({ adds: [{ symbol: "300476", name: "胜宏", global_supply: "yes" }] }),
    /adds\[0\]\.theme must be a non-empty string/,
  );
  assert.throws(
    () => validateRefreshProposal({
      adds: [{ symbol: "300476", name: "胜宏", theme: "AI-PCB", global_supply: "yes" }],
    }),
    /adds\[0\]\.global_supply must be a boolean/,
  );
});

test("validateRefreshProposal rejects malformed removes and reclassifies", async () => {
  const { validateRefreshProposal } = await import("../lib/universe-refresh");
  assert.throws(
    () => validateRefreshProposal({ removes: {} }),
    /removes must be an array/,
  );
  assert.throws(
    () => validateRefreshProposal({ removes: [123] }),
    /removes\[0\] must be a string/,
  );
  assert.throws(
    () => validateRefreshProposal({ reclassifies: "bad" }),
    /reclassifies must be an array/,
  );
  assert.throws(
    () => validateRefreshProposal({ reclassifies: [{ symbol: "000001" }] }),
    /reclassifies\[0\]\.theme must be a non-empty string/,
  );
  assert.throws(
    () => validateRefreshProposal({ rationale: 123 }),
    /rationale must be a string/,
  );
});

test("proposeRefresh rejects malformed LLM JSON before touching universe file", async () => {
  writeBase();
  const before = readRaw();
  const { proposeRefresh } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ adds: "not-an-array" }) } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    await assert.rejects(
      () => proposeRefresh(baseUniverse),
      /adds must be an array/,
    );
    assert.equal(readRaw(), before);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});
