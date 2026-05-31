import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-holdings-api-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/universe.json", JSON.stringify({
  updated_at: "2026-01-01",
  updated_by: "test",
  entries: [
    { symbol: "688256", name: "寒武纪", theme: "算力/AI芯片" },
    { symbol: "300308", name: "中际旭创", theme: "光模块" },
  ],
}, null, 2) + "\n");

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test("/api/holdings reports missing local holdings", async () => {
  const { GET } = await import("../app/api/holdings/route");
  const body = await json(await GET());
  assert.equal(body.ok, true);
  assert.equal(body.fileFound, false);
  assert.equal(body.filePath, "web/data/holdings.local.json");
});

test("/api/holdings writes valid holdings and rejects invalid updates", async () => {
  const { GET, PUT } = await import("../app/api/holdings/route");
  const valid = await json(await PUT(new NextRequest("http://test/api/holdings", {
    method: "PUT",
    body: JSON.stringify({
      cash: 100000,
      positions: [{ symbol: "688256", shares: 100, cost_basis: 120.5 }],
    }),
  })));
  assert.equal(valid.ok, true);
  assert.equal(fs.existsSync("data/holdings.local.json"), true);

  const found = await json(await GET());
  assert.equal(found.fileFound, true);
  assert.equal((found.holdings as { cash?: number }).cash, 100000);

  const before = fs.readFileSync("data/holdings.local.json", "utf-8");
  const invalidResponse = await PUT(new NextRequest("http://test/api/holdings", {
    method: "PUT",
    body: JSON.stringify({
      cash: 0,
      positions: [{ symbol: "000001", shares: 100, cost_basis: 1 }],
    }),
  }));
  const invalid = await json(invalidResponse);
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalid.ok, false);
  assert.match(String(invalid.error), /not in universe/);
  assert.equal(fs.readFileSync("data/holdings.local.json", "utf-8"), before);
});
