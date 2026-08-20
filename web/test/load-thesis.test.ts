import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXAMPLE_THESIS = `# 主题定义（示例，可复制为 thesis.md 后修改）

本模板默认研究中国 A 股 AI 基建供给侧：跟踪算力芯片、光模块/高速互连、AI 服务器、液冷散热、电力、IDC、存储/HBM、半导体设备与材料、AI-PCB、功率半导体、晶圆代工与云。优先识别与全球 AI capex / 海外供应链相关的标的，不做多纯人类消费品。

刷池子主题命名沿用：算力/AI芯片、光模块、AI服务器、液冷、电力、IDC、功率半导体、存储/HBM、半导体设备、半导体材料、AI-PCB、晶圆代工、云/AI基建。
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-thesis-"));
const prevCwd = process.cwd();

test.before(() => {
  process.chdir(tmp);
  fs.mkdirSync("data", { recursive: true });
});

test.after(() => {
  process.chdir(prevCwd);
});

test("loadThesisNarrative reads thesis.example.md when thesis.md is absent", async () => {
  fs.writeFileSync("data/thesis.example.md", EXAMPLE_THESIS);
  fs.rmSync("data/thesis.md", { force: true });
  const { loadThesisNarrative } = await import("../lib/load-thesis");
  const text = loadThesisNarrative();
  assert.match(text, /AI 基建供给侧/);
  assert.match(text, /算力\/AI芯片/);
});

test("loadThesisNarrative prefers thesis.md over thesis.example.md", async () => {
  fs.writeFileSync("data/thesis.example.md", EXAMPLE_THESIS);
  fs.writeFileSync("data/thesis.md", "自定义覆盖叙事\n");
  const { loadThesisNarrative } = await import("../lib/load-thesis");
  assert.equal(loadThesisNarrative(), "自定义覆盖叙事");
});

test("loadThesisNarrative throws when both thesis files are missing", async () => {
  fs.rmSync("data/thesis.example.md", { force: true });
  fs.rmSync("data/thesis.md", { force: true });
  const { loadThesisNarrative } = await import("../lib/load-thesis");
  assert.throws(() => loadThesisNarrative(), /thesis\.example\.md/);
});
