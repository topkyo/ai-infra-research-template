import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHoldingsText } from "../lib/holdingsImport";

test("parseHoldingsText accepts Chinese tab-separated brokerage rows", () => {
  const result = parseHoldingsText(`证券代码\t持仓数量\t成本价\t可用资金
688256\t100\t120.5\t50000
300308\t200\t88.2\t50000`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.cash, 50000);
  assert.deepEqual(result.positions, [
    { symbol: "688256", shares: 100, cost_basis: 120.5 },
    { symbol: "300308", shares: 200, cost_basis: 88.2 },
  ]);
});

test("parseHoldingsText accepts English CSV rows and normalizes symbols", () => {
  const result = parseHoldingsText(`symbol,shares,cost_basis
1,100,12.3
688256.SH,200,120.5`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.positions, [
    { symbol: "000001", shares: 100, cost_basis: 12.3 },
    { symbol: "688256", shares: 200, cost_basis: 120.5 },
  ]);
});

test("parseHoldingsText reports missing headers and invalid rows", () => {
  const missing = parseHoldingsText("代码\t数量\n688256\t100");
  assert.match(missing.errors.join(";"), /成本价/);

  const invalid = parseHoldingsText(`证券代码\t持仓数量\t成本价
688256\t0\t1
688256\t10\t1`);
  assert.match(invalid.errors.join(";"), /持仓数量无效/);
  assert.match(invalid.errors.join(";"), /重复证券代码/);
});
