#!/usr/bin/env bash
# Deploy the public docs/ snapshot to Vercel (Combo A public plane).
# Usage: ./scripts/deploy-public-snapshot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT/docs"

print_manual_deploy_steps() {
  cat <<'EOF'
Deploy the public snapshot without the Vercel CLI:

1. Vercel Dashboard
   - Import this GitHub repository as a new project.
   - Root Directory: docs
   - Framework Preset: Other (static site; no build command)
   - Deploy from the main branch after pushing docs/data/ snapshot updates.

2. Git integration (recommended)
   - Connect the repo in Vercel project settings.
   - Set Root Directory to docs and enable production deploys on push.
   - Refresh snapshot locally (web/scripts/snapshot.ts), commit docs/data/, then push.

3. CI / token deploy (optional)
   - Install the Vercel CLI: npm i -g vercel
   - Authenticate with `vercel login` or set VERCEL_TOKEN in the environment (do not echo it).
   - Re-run this script from the repository root.
EOF
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

if [ -z "${VERCEL_TOKEN:-}" ]; then
  if ! vercel whoami >/dev/null 2>&1; then
    echo "error: not authenticated with Vercel (set VERCEL_TOKEN or run vercel login)" >&2
    print_manual_deploy_steps
    exit 1
  fi
fi

echo "Deploying docs/ snapshot to Vercel production..."
vercel deploy --prod --yes --cwd "$DOCS_DIR"
