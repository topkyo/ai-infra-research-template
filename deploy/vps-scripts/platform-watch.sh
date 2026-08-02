#!/usr/bin/env bash
# platform-watch.sh — host resources (disk / memory)
set -uo pipefail

LOG="/home/tim/scripts/platform-watch.log"
ALERT="/home/tim/scripts/alert.sh"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
MEM_WARN_MB="${MEM_WARN_MB:-100}"

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

DISK_PCT=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
MEM_AVAIL_MB=$(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024 ))
fail=0

if [ "${DISK_PCT:-0}" -ge "$DISK_WARN_PCT" ]; then
  ALERT_TAG="[platform]" ALERT_KEY="disk" COOLDOWN_SEC=3600 \
    "$ALERT" "磁盘使用率 ${DISK_PCT}% >= ${DISK_WARN_PCT}%" || true
  fail=1
fi
if [ "${MEM_AVAIL_MB:-0}" -lt "$MEM_WARN_MB" ]; then
  ALERT_TAG="[platform]" ALERT_KEY="mem" COOLDOWN_SEC=1800 \
    "$ALERT" "可用内存仅 ${MEM_AVAIL_MB}MB < ${MEM_WARN_MB}MB" || true
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  log "OK disk=${DISK_PCT}% mem_avail=${MEM_AVAIL_MB}MB"
else
  log "WARN disk=${DISK_PCT}% mem_avail=${MEM_AVAIL_MB}MB"
fi
exit 0
