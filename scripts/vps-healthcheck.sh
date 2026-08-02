#!/usr/bin/env bash
# Combo A VPS healthcheck: disk, compose, localhost endpoints.
# Intended for cron on the VPS (SSH-tunnel mode; no public ports required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${MONITOR_LOG_DIR:-$ROOT/.monitor/logs}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000/}"
PY_URL="${PY_URL:-http://127.0.0.1:8001/health}"

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/vps-health-$(date +%Y-%m-%d).log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

fail=0
{
  echo "[$(ts)] vps-healthcheck start root=$ROOT"

  # Disk
  disk_line="$(df -P "$ROOT" | awk 'NR==2 {print $5" "$4}')"
  pct="${disk_line%%%*}"
  avail="$(echo "$disk_line" | awk '{print $2}')"
  echo "[$(ts)] disk used=${pct}% avail=${avail}"
  if [ "${pct}" -ge "${DISK_WARN_PCT}" ]; then
    echo "[$(ts)] WARN disk >= ${DISK_WARN_PCT}%"
    fail=1
  fi

  # Compose
  if command -v docker >/dev/null 2>&1; then
    if ! docker compose -f "$ROOT/docker-compose.yml" ps --status running --format '{{.Name}}' | grep -q .; then
      echo "[$(ts)] WARN no running compose services"
      fail=1
    else
      docker compose -f "$ROOT/docker-compose.yml" ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' || true
    fi
  else
    echo "[$(ts)] WARN docker not found"
    fail=1
  fi

  # Endpoints
  py_code="$(curl -sS -o /tmp/vps-health-py.json -w '%{http_code}' --max-time 10 "$PY_URL" || echo ERR)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL" || echo ERR)"
  echo "[$(ts)] pyserver_http=${py_code} web_http=${web_code}"
  if [ "$py_code" != "200" ] || [ "$web_code" != "200" ]; then
    echo "[$(ts)] WARN endpoint check failed"
    fail=1
  fi

  # Docker reclaimable hint
  if command -v docker >/dev/null 2>&1; then
    docker system df || true
  fi

  echo "[$(ts)] vps-healthcheck done fail=${fail}"
} >>"$LOG" 2>&1

# Keep 14 days of health logs
find "$LOG_DIR" -maxdepth 1 -name 'vps-health-*.log' -mtime +14 -delete 2>/dev/null || true

exit "$fail"
