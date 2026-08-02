#!/usr/bin/env bash
# Combo A VPS healthcheck: disk, compose, localhost endpoints.
# Intended for cron on the VPS (SSH-tunnel mode; no public ports required).
# Optional alerts via ~/scripts/alert.sh (Telegram/Slack) when present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${MONITOR_LOG_DIR:-$ROOT/.monitor/logs}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000/}"
PY_URL="${PY_URL:-http://127.0.0.1:8001/health}"
ALERT_SCRIPT="${ALERT_SCRIPT:-/home/tim/scripts/alert.sh}"

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/vps-health-$(date +%Y-%m-%d).log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

notify() {
  local key="$1"
  local msg="$2"
  echo "[$(ts)] WARN $msg" >>"$LOG"
  if [ -x "$ALERT_SCRIPT" ]; then
    ALERT_TAG="[dashboard]" ALERT_KEY="$key" COOLDOWN_SEC="${COOLDOWN_SEC:-3600}" \
      "$ALERT_SCRIPT" "$msg" 2>/dev/null || true
  fi
}

fail=0
{
  echo "[$(ts)] vps-healthcheck start root=$ROOT"

  disk_line="$(df -P "$ROOT" | awk 'NR==2 {print $5" "$4}')"
  pct="${disk_line%%%*}"
  avail="$(echo "$disk_line" | awk '{print $2}')"
  echo "[$(ts)] disk used=${pct}% avail=${avail}"
  if [ "${pct}" -ge "${DISK_WARN_PCT}" ]; then
    fail=1
    notify "dashboard-disk" "研究台磁盘使用率 ${pct}% >= ${DISK_WARN_PCT}%"
  fi

  if command -v docker >/dev/null 2>&1; then
    if ! docker compose -f "$ROOT/docker-compose.yml" ps --status running --format '{{.Name}}' | grep -q .; then
      fail=1
      notify "dashboard-compose" "研究台 Compose 无运行中服务"
    else
      docker compose -f "$ROOT/docker-compose.yml" ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' || true
    fi
  else
    fail=1
    notify "dashboard-docker" "研究台机器未找到 docker"
  fi

  py_code="$(curl -sS -o /tmp/vps-health-py.json -w '%{http_code}' --max-time 10 "$PY_URL" || echo ERR)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL" || echo ERR)"
  echo "[$(ts)] pyserver_http=${py_code} web_http=${web_code}"
  if [ "$py_code" != "200" ] || [ "$web_code" != "200" ]; then
    fail=1
    notify "dashboard-http" "研究台探活失败 pyserver=${py_code} web=${web_code}"
  fi

  if command -v docker >/dev/null 2>&1; then
    docker system df || true
  fi

  echo "[$(ts)] vps-healthcheck done fail=${fail}"
} >>"$LOG" 2>&1

find "$LOG_DIR" -maxdepth 1 -name 'vps-health-*.log' -mtime +14 -delete 2>/dev/null || true

exit "$fail"
