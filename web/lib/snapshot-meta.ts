export type SnapshotMetaSteps = {
  universe_refresh: boolean;
  analyst: boolean;
  signals: boolean;
  backtest: boolean;
};

export type SnapshotMetaBacktest = {
  included: boolean;
  retained_generated_at: string | null;
};

export type SnapshotMeta = {
  generated_at: string;
  universe_count: number;
  steps: SnapshotMetaSteps;
  backtest: SnapshotMetaBacktest;
  notes: string;
};

export function buildSnapshotMeta(input: {
  universeCount: number;
  generatedAt?: string;
  steps: SnapshotMetaSteps;
  /** ISO from existing docs/data/backtest.json when not included */
  retainedBacktestGeneratedAt?: string | null;
  notes?: string;
}): SnapshotMeta {
  const generated_at = input.generatedAt ?? new Date().toISOString();
  const included = input.steps.backtest;
  const retained = included
    ? null
    : (input.retainedBacktestGeneratedAt ?? null);
  const notes = input.notes ?? defaultNotes(input.steps, retained);
  return {
    generated_at,
    universe_count: input.universeCount,
    steps: { ...input.steps },
    backtest: { included, retained_generated_at: retained },
    notes,
  };
}

function defaultNotes(steps: SnapshotMetaSteps, retained: string | null): string {
  const parts: string[] = [];
  if (steps.universe_refresh) parts.push("universe refresh attempted");
  if (steps.analyst) parts.push("analyst");
  if (steps.signals) parts.push("signals");
  if (steps.backtest) parts.push("backtest included");
  else if (retained) parts.push(`backtest retained (${retained})`);
  else parts.push("backtest skipped (none retained)");
  return parts.join("; ");
}
