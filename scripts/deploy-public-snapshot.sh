#!/usr/bin/env bash
# Deploy the public docs/ snapshot to Vercel (Combo A public plane).
# Source of truth: host-local docs/data/*.json (gitignored). Not GitHub Actions.
# Usage: ./scripts/deploy-public-snapshot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT/docs"
DATA_DIR="$DOCS_DIR/data"

print_manual_deploy_steps() {
  cat <<'EOF'
Public snapshot deploy is CLI-only (Combo A):

1. On the VPS (or any host with fresh docs/data):
   - Generate: ./scripts/vps-refresh-public-snapshot.sh  (or web/scripts/snapshot.ts)
   - Deploy:   export VERCEL_TOKEN=… && ./scripts/deploy-public-snapshot.sh

2. Vercel project settings (one-time):
   - Root Directory: docs
   - Framework Preset: Other (static; no build)
   - Disable Git-connected automatic production deploys for this project
     (otherwise a docs/** git push can still publish an empty/stale tree)

3. Install CLI if needed: npm i -g vercel
   Authenticate with VERCEL_TOKEN or `vercel login` (do not echo the token).

GitHub Actions does not deploy snapshot JSON from the repo.
EOF
}

require_snapshot_files() {
  local missing=0
  local f
  for f in meta.json universe.json analyst.json signals.json backtest.json; do
    if [[ ! -f "$DATA_DIR/$f" ]]; then
      echo "error: missing $DATA_DIR/$f (generate with snapshot/one-shot first)" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
}

# Refuse to ship docs/data that is clearly older than the private desk universe
# (typical after git pull restored tracked JSON, or never re-ran snapshot).
guard_against_stale_vs_web_universe() {
  if [[ "${FORCE_STALE_SNAPSHOT_DEPLOY:-}" == "1" ]]; then
    echo "warning: FORCE_STALE_SNAPSHOT_DEPLOY=1 — skipping staleness guard" >&2
    return 0
  fi
  local web_universe="$ROOT/web/data/universe.json"
  if [[ ! -f "$web_universe" ]]; then
    return 0
  fi
  python3 - "$web_universe" "$DATA_DIR/universe.json" "$DATA_DIR/meta.json" <<'PY'
import json, sys
from datetime import date

web_path, docs_uni_path, meta_path = sys.argv[1:4]
web = json.loads(open(web_path, encoding="utf-8").read())
docs = json.loads(open(docs_uni_path, encoding="utf-8").read())
meta = json.loads(open(meta_path, encoding="utf-8").read())

web_n = len(web.get("entries") or [])
docs_n = len(docs.get("entries") or [])
web_updated = str(web.get("updated_at") or "")
docs_updated = str(docs.get("updated_at") or "")
meta_count = meta.get("universe_count")

reasons = []
if web_n and docs_n and web_n > docs_n:
    reasons.append(f"web universe has {web_n} entries but docs/data has {docs_n}")
if web_updated and docs_updated and web_updated > docs_updated:
    reasons.append(f"web updated_at={web_updated} is newer than docs updated_at={docs_updated}")
if isinstance(meta_count, int) and web_n and meta_count < web_n:
    reasons.append(f"meta.universe_count={meta_count} < web entries={web_n}")

# meta.generated_at older than 14 days while web pool was touched today-ish is a soft signal only
gen = str(meta.get("generated_at") or "")
if gen.startswith("20") and len(gen) >= 10:
    try:
        gen_day = date.fromisoformat(gen[:10])
        if (date.today() - gen_day).days > 14 and web_n > docs_n:
            reasons.append(f"meta.generated_at={gen} looks stale")
    except ValueError:
        pass

if reasons:
    print("error: refusing to deploy stale docs/data vs web/data/universe.json:", file=sys.stderr)
    for r in reasons:
        print(f"  - {r}", file=sys.stderr)
    print("Regenerate with ./scripts/vps-refresh-public-snapshot.sh, or set FORCE_STALE_SNAPSHOT_DEPLOY=1", file=sys.stderr)
    sys.exit(1)
PY
}

if ! command -v vercel >/dev/null 2>&1; then
  echo "error: vercel CLI not found in PATH" >&2
  print_manual_deploy_steps
  exit 2
fi

if [ ! -d "$DOCS_DIR" ]; then
  echo "error: docs directory not found: $DOCS_DIR" >&2
  exit 1
fi

require_snapshot_files
guard_against_stale_vs_web_universe

if [ -z "${VERCEL_TOKEN:-}" ]; then
  if ! vercel whoami >/dev/null 2>&1; then
    echo "error: not authenticated with Vercel (set VERCEL_TOKEN or run vercel login)" >&2
    print_manual_deploy_steps
    exit 1
  fi
fi

echo "Deploying docs/ snapshot to Vercel production (host docs/data, not git)..."
vercel deploy --prod --yes --cwd "$DOCS_DIR"
