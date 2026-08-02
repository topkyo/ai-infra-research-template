#!/usr/bin/env bash
# Combo A VPS healthcheck: compose + localhost endpoints.
# Routine disk paging is owned by ~/scripts/platform-watch.sh (same root FS); here disk is
# log-only below DISK_CRIT_PCT (default 95) and pages once at/above it as backstop
# (ALERT_KEY=disk-crit, distinct from platform-watch's "disk" key, so no double-paging).
# Optional alerts via ~/scripts/alert.sh (Telegram/Slack) when present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${MONITOR_LOG_DIR:-$ROOT/.monitor/logs}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000/}"
PY_URL="${PY_URL:-http://127.0.0.1:8001/health}"
ALERT_SCRIPT="${ALERT_SCRIPT:-/home/tim/scripts/alert.sh}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-95}"
# Healthchecks.io dead-man's-switch (optional). File contains a single ping URL, mode 600.
HC_PING_URL_FILE="${HC_PING_URL_FILE:-/home/tim/scripts/.healthchecks-ping}"

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/vps-health-$(date +%Y-%m-%d).log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Ping external watchdog so silence is visible when TG/Slack are both dead.
# Success → base URL; failure → base/fail (Healthchecks.io convention). Never changes exit code.
hc_ping() {
  local ok="$1"
  local url="${HEALTHCHECKS_PING_URL:-}"
  if [ -z "$url" ] && [ -f "$HC_PING_URL_FILE" ]; then
    url="$(tr -d ' \t\r\n' < "$HC_PING_URL_FILE" || true)"
  fi
  if [ -z "$url" ]; then
    return 0
  fi
  if [ "$ok" -eq 0 ]; then
    curl -fsS -m 10 "$url" >/dev/null 2>&1 \
      && echo "[$(ts)] hc_ping ok" >>"$LOG" \
      || echo "[$(ts)] WARN hc_ping failed (success URL)" >>"$LOG"
  else
    curl -fsS -m 10 "${url%/}/fail" >/dev/null 2>&1 \
      && echo "[$(ts)] hc_ping fail-signal ok" >>"$LOG" \
      || echo "[$(ts)] WARN hc_ping failed (fail URL)" >>"$LOG"
  fi
}

notify() {
  local key="$1"
  local msg="$2"
  echo "[$(ts)] WARN $msg" >>"$LOG"
  if [ -x "$ALERT_SCRIPT" ]; then
    # stderr from alert.sh (channel failures) should land in the health log
    ALERT_TAG="[dashboard]" ALERT_KEY="$key" COOLDOWN_SEC="${COOLDOWN_SEC:-3600}" \
      "$ALERT_SCRIPT" "$msg" >>"$LOG" 2>&1 || true
  else
    # No paging channel: fd 3 is the original (cron) stderr, bypassing the log
    # redirect, so a missing/broken alert.sh can never silently swallow a failure.
    echo "[$(ts)] WARN paging unavailable: $ALERT_SCRIPT not executable; not paged: $msg" >&3
  fi
}

# fd 3 keeps the original stderr (cron mail / terminal) so notify() can still reach the
# operator when the paging channel itself is missing, despite the log redirect below.
exec 3>&2
fail=0
{
  echo "[$(ts)] vps-healthcheck start root=$ROOT"

  disk_line="$(df -P "$ROOT" | awk 'NR==2 {print $5" "$4}')"
  pct="${disk_line%%%*}"
  avail="$(echo "$disk_line" | awk '{print $2}')"
  echo "[$(ts)] disk used=${pct}% avail=${avail} (log-only below ${DISK_CRIT_PCT}%; routine paging via platform-watch)"
  # Backstop only; routine disk paging stays with platform-watch (different ALERT_KEY).
  if [ "$pct" -ge "$DISK_CRIT_PCT" ] 2>/dev/null; then
    fail=1
    notify "disk-crit" "研究台磁盘紧急 used=${pct}% avail=${avail}（>=${DISK_CRIT_PCT}% 兜底；常规由 platform-watch 负责）"
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

hc_ping "$fail"

find "$LOG_DIR" -maxdepth 1 -name 'vps-health-*.log' -mtime +14 -delete 2>/dev/null || true

exit "$fail"
