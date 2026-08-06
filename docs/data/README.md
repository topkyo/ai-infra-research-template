# `docs/data/` — generated public snapshot (not in git)

JSON files here (`meta.json`, `universe.json`, `analyst.json`, `signals.json`, `backtest.json`) are **generated** by `web/scripts/snapshot.ts` / `scripts/vps-refresh-public-snapshot.sh` and deployed to Vercel with `scripts/deploy-public-snapshot.sh`.

They are gitignored on purpose so:

1. Merging docs/markdown cannot ship stale market data via Actions
2. `git pull` on the VPS cannot overwrite a fresh local snapshot

**Do not commit these JSON files.** Refresh and deploy from the VPS (Combo A).
