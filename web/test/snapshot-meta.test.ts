import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotMeta } from "../lib/snapshot-meta";

const baseSteps = {
  universe_refresh: true,
  analyst: true,
  signals: true,
  backtest: false,
};

test("steps.backtest=false + retained ISO → included=false, retained preserved, notes mention retained", () => {
  const retained = "2026-08-01T12:00:00.000Z";
  const meta = buildSnapshotMeta({
    universeCount: 42,
    generatedAt: "2026-08-06T05:00:00.000Z",
    steps: baseSteps,
    retainedBacktestGeneratedAt: retained,
  });

  assert.equal(meta.backtest.included, false);
  assert.equal(meta.backtest.retained_generated_at, retained);
  assert.match(meta.notes, /backtest retained \(2026-08-01T12:00:00\.000Z\)/);
  assert.equal(meta.universe_count, 42);
  assert.equal(meta.generated_at, "2026-08-06T05:00:00.000Z");
});

test("steps.backtest=true → included=true, retained_generated_at=null (ignore passed retained)", () => {
  const meta = buildSnapshotMeta({
    universeCount: 10,
    generatedAt: "2026-08-06T05:00:00.000Z",
    steps: { ...baseSteps, backtest: true },
    retainedBacktestGeneratedAt: "2026-08-01T12:00:00.000Z",
  });

  assert.equal(meta.backtest.included, true);
  assert.equal(meta.backtest.retained_generated_at, null);
  assert.match(meta.notes, /backtest included/);
  assert.doesNotMatch(meta.notes, /retained/);
});

test("custom notes override default", () => {
  const custom = "manual override for audit";
  const meta = buildSnapshotMeta({
    universeCount: 5,
    steps: baseSteps,
    retainedBacktestGeneratedAt: "2026-08-01T12:00:00.000Z",
    notes: custom,
  });

  assert.equal(meta.notes, custom);
});
