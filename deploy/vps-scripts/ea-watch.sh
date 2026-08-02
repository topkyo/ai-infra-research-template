#!/usr/bin/env bash
# ea-watch.sh — Embodied Agent application plane
set -uo pipefail

LOG="/home/tim/scripts/ea-watch.log"
ALERT_LOG="/home/tim/scripts/health-alerts.log"
ALERT="/home/tim/scripts/alert.sh"

FAILED=0
alert() {
  echo "$(date -Iseconds) ALERT: $1" >> "$ALERT_LOG"
  ALERT_TAG="[ea]" ALERT_KEY="$2" COOLDOWN_SEC="${3:-1800}" "$ALERT" "$1" 2>/dev/null || true
  FAILED=1
}

check_http() {
  local name="$1" url="$2" key="$3"
  local code
  code=$(curl -sS -o /tmp/ea-watch-body -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo ERR)
  if [ "$code" != "200" ]; then
    alert "${name} 检查失败 http=${code} url=${url}" "$key"
    return 1
  fi
  return 0
}

check_http "API localhost" "http://127.0.0.1:3001/health" "ea-api-http" || true
check_http "Caddy localhost" "http://127.0.0.1:80/health" "ea-caddy-http" || true

for svc in ea-api ea-simulator@node-sim-gh-001 ea-simulator@node-sim-gh-002 mosquitto caddy cloudflared-tunnel; do
  if ! systemctl is-active --quiet "$svc"; then
    alert "服务 ${svc} 未运行" "unit-${svc}"
  fi
done

if [ "$FAILED" -eq 0 ]; then
  echo "$(date -Iseconds) OK" >> "$LOG"
else
  echo "$(date -Iseconds) DONE with failures" >> "$LOG"
fi
exit 0
