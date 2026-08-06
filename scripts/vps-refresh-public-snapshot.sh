#!/usr/bin/env bash
# One-shot: refresh docs/data on the VPS host, then deploy the public snapshot.
#
# Usage (on goyun, from repo root):
#   # 日常（默认：刷池 + 信号，跳过回测）
#   ./scripts/vps-refresh-public-snapshot.sh
#
#   # 体检并更新公开回测
#   SNAPSHOT_INCLUDE_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh
#
#   # 跳过刷池
#   SNAPSHOT_SKIP_UNIVERSE_REFRESH=1 ./scripts/vps-refresh-public-snapshot.sh
#
# Optional env:
#   SNAPSHOT_SKIP_SIGNALS=1                            # light refresh (skip signals)
#   SNAPSHOT_BACKTEST_START / SNAPSHOT_BACKTEST_END
#   VERCEL_TOKEN_FILE=~/scripts/.vercel-token          # default
#   SKIP_DEPLOY=1                                      # only regenerate docs/data
#   GIT_COMMIT_DOCS=1                                  # also commit+push docs/data
#
# Prerequisites:
#   - docker compose stack healthy (pyserver on 127.0.0.1:8001)
#   - repo .env has LLM_PROVIDER + DEEPSEEK_API_KEY (or OPENCODE_GO_*)
#   - vercel CLI + token file (or VERCEL_TOKEN) for deploy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERCEL_TOKEN_FILE="${VERCEL_TOKEN_FILE:-$HOME/scripts/.vercel-token}"
LOG="${SNAPSHOT_LOG:-/tmp/topkyo-snapshot.log}"

echo "[vps-snapshot] root=$ROOT"

# --- 1) private plane health ---
if ! curl -sf -m 10 http://127.0.0.1:8001/health >/dev/null; then
  echo "[vps-snapshot] pyserver unhealthy — starting compose…"
  docker compose up -d
  for _ in $(seq 1 30); do
    curl -sf -m 5 http://127.0.0.1:8001/health >/dev/null && break
    sleep 2
  done
  curl -sf -m 10 http://127.0.0.1:8001/health >/dev/null \
    || { echo "[vps-snapshot] error: pyserver still down" >&2; exit 1; }
fi
echo "[vps-snapshot] pyserver ok"

# --- 2) web/.env.local for snapshot.ts (loads only .env.local) ---
umask 077
TMP_ENV="$(mktemp)"
# shellcheck disable=SC2016
grep -E '^(LLM_PROVIDER|DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|OPENCODE_GO_API_KEY|OPENCODE_GO_BASE_URL|LLM_MODEL|LLM_MODEL_BACKTEST|LLM_SCORE_BATCH_SIZE|SIGNALS_|BACKTEST_)=' .env \
  >"$TMP_ENV" || true
if ! grep -q '^DEEPSEEK_API_KEY=.\+' "$TMP_ENV" && ! grep -q '^OPENCODE_GO_API_KEY=.\+' "$TMP_ENV"; then
  echo "[vps-snapshot] error: no LLM API key in .env" >&2
  rm -f "$TMP_ENV"
  exit 1
fi
{
  cat "$TMP_ENV"
  echo "PYSERVER_URL=http://127.0.0.1:8001"
} > web/.env.local
rm -f "$TMP_ENV"
chmod 600 web/.env.local
echo "[vps-snapshot] wrote web/.env.local (PYSERVER_URL=http://127.0.0.1:8001)"

# --- 3) host node_modules (do NOT run snapshot inside production web image — no /app/lib) ---
if [[ ! -d web/node_modules/tsx ]]; then
  echo "[vps-snapshot] npm ci in web/ (first run)…"
  ( cd web && npm ci --no-audit --no-fund )
fi

# Lower concurrency on small VPS (≈2GiB) unless caller overrides.
export BACKTEST_SIGNAL_CONCURRENCY="${BACKTEST_SIGNAL_CONCURRENCY:-2}"
export BACKTEST_LOAD_CONCURRENCY="${BACKTEST_LOAD_CONCURRENCY:-3}"
export SIGNALS_LOAD_CONCURRENCY="${SIGNALS_LOAD_CONCURRENCY:-2}"
export SIGNALS_LLM_SCORE_BATCH_SIZE="${SIGNALS_LLM_SCORE_BATCH_SIZE:-5}"
export BACKTEST_LLM_SCORE_BATCH_SIZE="${BACKTEST_LLM_SCORE_BATCH_SIZE:-5}"

# --- 4) universe refresh (default on) ---
if [[ "${SNAPSHOT_SKIP_UNIVERSE_REFRESH:-}" == "1" ]]; then
  export SNAPSHOT_STEP_UNIVERSE_REFRESH=0
  echo "[vps-snapshot] SNAPSHOT_SKIP_UNIVERSE_REFRESH=1 — skipping universe refresh"
else
  echo "[vps-snapshot] running web/scripts/refresh-universe.ts…"
  if ! ( cd web && npx tsx scripts/refresh-universe.ts ); then
    echo "[vps-snapshot] error: universe refresh failed" >&2
    exit 1
  fi
  export SNAPSHOT_STEP_UNIVERSE_REFRESH=1
  # Host umask may leave universe.json as 0600; Compose web (uid 1001) must read it.
  chmod 664 web/data/universe.json 2>/dev/null || true
  echo "[vps-snapshot] universe refresh ok"
fi

# --- 5) backtest default skip ---
if [[ "${SNAPSHOT_INCLUDE_BACKTEST:-}" == "1" ]]; then
  unset SNAPSHOT_SKIP_BACKTEST 2>/dev/null || true
  echo "[vps-snapshot] SNAPSHOT_INCLUDE_BACKTEST=1 — running backtest in snapshot"
else
  export SNAPSHOT_SKIP_BACKTEST=1
fi

# --- 6) generate docs/data ---
echo "[vps-snapshot] running web/scripts/snapshot.ts (log: $LOG)…"
set +e
( cd web && npx tsx scripts/snapshot.ts ) 2>&1 | tee "$LOG"
snap_rc=${PIPESTATUS[0]}
set -e
if [[ "$snap_rc" -ne 0 ]]; then
  echo "[vps-snapshot] error: snapshot failed (exit $snap_rc). See $LOG" >&2
  exit "$snap_rc"
fi
echo "[vps-snapshot] snapshot ok"
python3 - <<'PY'
import json
from pathlib import Path
meta = json.loads(Path("docs/data/meta.json").read_text())
print(f"[vps-snapshot] meta.generated_at={meta.get('generated_at')} universe_count={meta.get('universe_count')}")
PY

# --- 7) deploy public plane ---
if [[ "${SKIP_DEPLOY:-}" == "1" ]]; then
  echo "[vps-snapshot] SKIP_DEPLOY=1 — not deploying"
else
  if [[ -z "${VERCEL_TOKEN:-}" && -f "$VERCEL_TOKEN_FILE" ]]; then
    VERCEL_TOKEN="$(tr -d '[:space:]' <"$VERCEL_TOKEN_FILE")"
    export VERCEL_TOKEN
  fi
  if [[ -z "${VERCEL_TOKEN:-}" ]] && ! vercel whoami >/dev/null 2>&1; then
    echo "[vps-snapshot] error: set VERCEL_TOKEN or create $VERCEL_TOKEN_FILE" >&2
    exit 1
  fi
  # Pin the existing public project — bare `vercel deploy` may create a new
  # "docs" project when docs/.vercel/project.json is missing on the VPS.
  mkdir -p docs/.vercel
  if [[ ! -f docs/.vercel/project.json ]]; then
    if [[ -n "${VERCEL_ORG_ID:-}" && -n "${VERCEL_PROJECT_ID:-}" ]]; then
      printf '%s\n' "{\"projectId\":\"${VERCEL_PROJECT_ID}\",\"orgId\":\"${VERCEL_ORG_ID}\"}" \
        > docs/.vercel/project.json
    else
      # Known Combo A public project (ai-infra-dashboard-docs).
      printf '%s\n' '{"projectId":"prj_pHPcGwsPUjpEnBQLmdbiBD45VojP","orgId":"team_vZF69jAbikZqLi7whDRvrSx3","projectName":"ai-infra-dashboard-docs"}' \
        > docs/.vercel/project.json
    fi
  fi
  echo "[vps-snapshot] deploying docs/ to Vercel production…"
  ./scripts/deploy-public-snapshot.sh
  echo "[vps-snapshot] public URL: https://ai-infra-dashboard-docs.vercel.app"
fi

# --- 8) optional git commit (keeps GitHub + Actions in sync) ---
if [[ "${GIT_COMMIT_DOCS:-}" == "1" ]]; then
  git add docs/data
  if git diff --cached --quiet; then
    echo "[vps-snapshot] no docs/data changes to commit"
  else
    git commit -m "chore: refresh public snapshot"
    git push origin HEAD
    echo "[vps-snapshot] pushed docs/data (Actions may also redeploy)"
  fi
fi

echo "[vps-snapshot] done"
