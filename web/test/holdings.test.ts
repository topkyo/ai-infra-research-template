import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-holdings-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });

const universe = [
  { symbol: "688256", name: "寒武纪", theme: "算力/AI芯片" },
  { symbol: "300308", name: "中际旭创", theme: "光模块" },
];

function writeHoldings(value: unknown) {
  fs.writeFileSync("data/holdings.local.json", JSON.stringify(value, null, 2) + "\n");
}

test("readHoldings treats a missing local holdings file as empty with warning", async () => {
  const { readHoldings } = await import("../lib/holdings");
  const holdings = readHoldings(universe);
  assert.equal(holdings.fileFound, false);
  assert.equal(holdings.cash, 0);
  assert.deepEqual(holdings.positions, []);
  assert.match(holdings.warnings[0], /not found/);
});

test("readHoldings accepts cash plus shares and cost basis", async () => {
  writeHoldings({
    updated_at: "2026-05-31",
    cash: 100000,
    positions: [{ symbol: "688256", shares: 100, cost_basis: 120.5 }],
  });
  const { readHoldings } = await import("../lib/holdings");
  const holdings = readHoldings(universe);
  assert.equal(holdings.fileFound, true);
  assert.equal(holdings.cash, 100000);
  assert.equal(holdings.positions[0].symbol, "688256");
});

test("readHoldings rejects invalid local holdings files", async () => {
  const { readHoldings } = await import("../lib/holdings");
  writeHoldings({ cash: -1, positions: [] });
  assert.throws(() => readHoldings(universe), /cash/);

  writeHoldings({
    cash: 0,
    positions: [
      { symbol: "688256", shares: 100, cost_basis: 1 },
      { symbol: "688256", shares: 50, cost_basis: 1 },
    ],
  });
  assert.throws(() => readHoldings(universe), /duplicate.*688256/);

  writeHoldings({ cash: 0, positions: [{ symbol: "000001", shares: 100, cost_basis: 1 }] });
  assert.throws(() => readHoldings(universe), /not in universe/);

  writeHoldings({ cash: 0, positions: [{ symbol: "688256", shares: 0, cost_basis: 1 }] });
  assert.throws(() => readHoldings(universe), /shares/);
});
