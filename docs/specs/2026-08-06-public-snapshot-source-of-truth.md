# Public snapshot source of truth (Combo A)

**Date:** 2026-08-06  
**Status:** Approved (implement)

## Goal

Prevent stale git `docs/data` from overwriting a fresh Vercel production snapshot after docs-only pushes or `git pull` on the VPS.

## Decision

| Concern | Rule |
|---|---|
| Source of truth | Host-generated `docs/data/*.json` on the research VPS (or laptop), deployed only via `scripts/deploy-public-snapshot.sh` / one-shot |
| Git | Do **not** track snapshot JSON; ignore `docs/data/*.json` |
| GitHub Actions | No automatic Vercel deploy on `docs/**` push; workflow may only remind operators to use VPS CLI |
| Vercel Git integration | Ignored Build Step = `exit 0` (skip all Git-triggered builds); production updates via CLI only |

## Non-goals

- Changing snapshot generation semantics or spend tiers
- Hosting private holdings in `docs/data`

## Verification

- Push a `docs/*.md`-only change → Actions does not deploy Vercel
- `git pull` on VPS does not delete/replace local `docs/data/*.json`
- `deploy-public-snapshot.sh` refuses when `docs/data` is clearly older than `web/data/universe.json` unless `FORCE_STALE_SNAPSHOT_DEPLOY=1`
