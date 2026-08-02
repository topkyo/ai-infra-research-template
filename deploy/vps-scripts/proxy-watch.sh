#!/usr/bin/env bash
# proxy-watch.sh — sing-box proxy plane
set -uo pipefail

LOG="/home/tim/scripts/proxy-watch.log"
ALERT="/home/tim/scripts/alert.sh"
UNIT="${PROXY_UNIT:-sing-box}"
# clash-compatible controller commonly on 9090; sing-box experimental API on 2019
CTRL_URL="${PROXY_CTRL_URL:-http://127.0.0.1:9090}"

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }
fail=0

if ! systemctl is-active --quiet "$UNIT"; then
  ALERT_TAG="[proxy]" ALERT_KEY="sing-box-unit" COOLDOWN_SEC=1800 \
    "$ALERT" "服务 ${UNIT} 未运行" || true
  fail=1
fi

# Controller probe (best-effort; 401/404 still means process is listening)
ctrl_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$CTRL_URL" 2>/dev/null || echo ERR)
case "$ctrl_code" in
  200|401|403|404|405) ;;
  *)
    ALERT_TAG="[proxy]" ALERT_KEY="sing-box-ctrl" COOLDOWN_SEC=1800 \
      "$ALERT" "sing-box 控制面不可达 ${CTRL_URL} http=${ctrl_code}" || true
    fail=1
    ;;
esac

if [ "$fail" -eq 0 ]; then
  log "OK unit=${UNIT} ctrl_http=${ctrl_code}"
else
  log "WARN unit=${UNIT} ctrl_http=${ctrl_code}"
fi
exit 0
