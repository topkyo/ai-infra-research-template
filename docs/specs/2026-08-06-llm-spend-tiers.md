# LLM 花费档位与发布链路

**Date:** 2026-08-06  
**Status:** Approved

## Goal

Align the research/publish pipeline with LLM cost: high-value steps (universe refresh, live signals) stay cheap and frequent; full-year backtest is manual “strategy health check” only. Default public one-shot refresh must not burn hundreds of backtest LLM batches; when backtest is skipped, keep the previous public `backtest.json` and expose an auditable note in `meta` / public UI.

## Constraints

- Strict failure semantics unchanged: no synthetic signals, trades, or “successful” universe writes on LLM/data failure; empty universe proposal may succeed without touching `updated_at`.
- Public snapshot continues to use `scoreSymbols` (no holdings), not private `scorePortfolioTargets`.
- Combo A: private research on VPS; public static `docs/` on Vercel.
- Do not enable automatic cron backtest in this change.
- Prefer small, explicit env knobs over a large new framework.

## Design

### Spend tiers

| Tier | When | Actions | Relative cost |
|------|------|---------|---------------|
| Daily / default one-shot | Refresh public page or light sync | Universe refresh → analyst → signals → **skip backtest** → meta → deploy | Low |
| Research day (private) | Daily screening | `/signals`; universe refresh as needed; no default full-year backtest | Low |
| Health check (manual opt-in) | After strategy or universe material change | Private `/backtest` UI **or** CLI with backtest included, then deploy if public must update | High (intentional) |

### Architecture

```text
# Default public one-shot
refresh-universe → snapshot(analyst + signals, skip backtest)
  → meta(backtest retained + notes) → Vercel deploy

# Health check → public
SNAPSHOT_INCLUDE_BACKTEST=1 → same chain but snapshot runs backtest
  → overwrites docs/data/backtest.json when success only
```

Private `/backtest` remains the interactive health-check UI; it does not auto-deploy public docs.

### Components

1. **`scripts/vps-refresh-public-snapshot.sh`**
   - Default: run universe refresh before snapshot (use existing `web/scripts/refresh-universe.ts` or equivalent).
   - Default: skip backtest (`SNAPSHOT_SKIP_BACKTEST=1` unless opted in).
   - Opt-out universe: `SNAPSHOT_SKIP_UNIVERSE_REFRESH=1`.
   - Opt-in backtest: `SNAPSHOT_INCLUDE_BACKTEST=1` (clears skip for that run).
   - On snapshot failure after universe refresh: exit non-zero; do not treat partial publish as full success.
   - Document both commands in script header comments.

2. **`web/scripts/snapshot.ts`**
   - When backtest skipped: do not delete or rewrite `docs/data/backtest.json`.
   - Always write `meta.json` with structured fields (below).
   - When backtest runs and fails: leave previous `backtest.json` intact; meta must not claim a successful new backtest.

3. **`meta.json` shape** (extend, keep backward-compatible readers)

```json
{
  "generated_at": "<ISO>",
  "universe_count": 104,
  "steps": {
    "universe_refresh": true,
    "analyst": true,
    "signals": true,
    "backtest": false
  },
  "backtest": {
    "included": false,
    "retained_generated_at": "<ISO from existing backtest.json or null>"
  },
  "notes": "human-readable short summary"
}
```

When `included: true`, set `retained_generated_at` to null (or omit) and ensure `notes` / `steps.backtest` reflect a fresh run. Prefer reading existing `backtest.json`’s `generated_at` for retention.

4. **Public UI (`docs/app.js`)**
   - Meta line continues to show data generation time and universe `updated_at` / `updated_by`.
   - When `meta.backtest.included === false` and a retained timestamp exists, append a short phrase such as「回测沿用至 YYYY-MM-DD HH:mm（北京时间）」.
   - Missing new fields must not break the page (fallback to current behavior).

5. **Private `/backtest` page**
   - Position copy as「策略体检」: expensive, not daily; run after material strategy/universe changes.
   - Keep existing form options (window, rebalance, fees, etc.) as the UI opt-in.
   - Primary action label/copy should read as running a health check, not a routine refresh.
   - Do not add auto-deploy-to-Vercel from this page in this spec.

6. **Docs**
   - `docs/OPERATIONS.md`, `README.md` (LLM / snapshot section), `docs/COMBO_A_RUNBOOK.md`: document tiers and the two commands:

```bash
./scripts/vps-refresh-public-snapshot.sh
SNAPSHOT_INCLUDE_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh
```

### Data flow

1. Operator runs daily one-shot on VPS host (not inside prod web image).
2. Universe refresh may rewrite `web/data/universe.json` only on real add/remove/reclass.
3. Snapshot copies universe, regenerates analyst + signals, skips backtest by default.
4. Meta records steps + retained backtest timestamp; deploy `docs/` to Vercel.
5. Health check: either private UI for research, or `SNAPSHOT_INCLUDE_BACKTEST=1` when public backtest must update.

### Error handling

| Step | On failure |
|------|------------|
| Universe refresh | Abort one-shot; no silent “no-op success” on LLM error; empty proposal continues without file write |
| Analyst / signals | Existing snapshot hard-fail; no fake signals |
| Backtest (opt-in only) | Do not overwrite prior `backtest.json`; meta `included=false` + failure visible in process exit / notes if partial meta write is used |
| Skip backtest (default) | Not an error; retain file + annotate meta |

### Testing

- Unit test helper (if extracted) for building `meta.backtest` / `notes` given skip vs include vs retain.
- Documented manual checks: default one-shot skips backtest; `INCLUDE_BACKTEST=1` path documented; public meta line shows retained backtest when applicable.
- `/backtest` copy change is visual/copy-only; no mandatory e2e.

## Out of scope

- Disabling DeepSeek thinking mode or changing default Flash/Pro model policy.
- Changing private `/api/backtest` default one-year window globally.
- Switching public snapshot scoring to portfolio/holdings-aware targets.
- Automatic cron backtest or DeepSeek balance preflight.
- Fixing VPS env wiring for `SIGNALS_LLM_SCORE_BATCH_SIZE` → snapshot (unless a trivial drive-by).

## Open questions

(none)
