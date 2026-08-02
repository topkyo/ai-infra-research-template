#!/usr/bin/env bash
# alert.sh — Telegram + Slack with tag and per-channel cooldown
# Usage:
#   alert.sh "message"
#   ALERT_TAG=proxy ALERT_KEY=sing-box COOLDOWN_SEC=1800 alert.sh "sing-box down"
# Cooldown stamps are per channel: ${ALERT_KEY}.telegram / ${ALERT_KEY}.slack
# A channel is stamped only after that channel accepts the send, so one success
# cannot suppress retries on the other.
set -euo pipefail

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "usage: alert.sh \"message\"" >&2
  exit 2
fi

TAG="${ALERT_TAG:-[ops]}"
KEY="${ALERT_KEY:-}"
COOLDOWN_SEC="${COOLDOWN_SEC:-1800}"
STATE_DIR="${ALERT_STATE_DIR:-/home/tim/scripts/.alert-state}"
ALERT_LOG="${ALERT_LOG:-/home/tim/scripts/health-alerts.log}"
mkdir -p "$STATE_DIR"

# Serialize cooldown check -> send -> stamp across concurrent watchers (*/5 cron can
# overlap a slow run). Without this, two same-key invocations can both see "no stamp"
# and double-push. If flock is unavailable we fall back to the previous unlocked behavior.
exec 9>"$STATE_DIR/.lock"
if command -v flock >/dev/null 2>&1; then
  flock 9
fi

TIMESTAMP=$(date -Iseconds)
TEXT="${TAG} ${TIMESTAMP} ${MSG}"

alog() {
  printf "%s %s\n" "$(date -Iseconds)" "$*" >>"$ALERT_LOG"
}

safe_key=""
now=""
use_cooldown=0
if [ -n "$KEY" ] && [ "$COOLDOWN_SEC" -gt 0 ] 2>/dev/null; then
  use_cooldown=1
  safe_key=$(printf "%s" "$KEY" | tr -c "A-Za-z0-9._-" "_")
  now=$(date +%s)
fi

channel_in_cooldown() {
  local channel="$1"
  if [ "$use_cooldown" -ne 1 ]; then
    return 1
  fi
  local stamp_file="$STATE_DIR/${safe_key}.${channel}"
  if [ ! -f "$stamp_file" ]; then
    return 1
  fi
  local last
  last=$(tr -d " \t\r\n" < "$stamp_file" || true)
  if [ -n "${last:-}" ] && [ "$last" -eq "$last" ] 2>/dev/null; then
    if [ $((now - last)) -lt "$COOLDOWN_SEC" ]; then
      return 0
    fi
  fi
  return 1
}

stamp_channel() {
  local channel="$1"
  if [ "$use_cooldown" -ne 1 ] || [ -z "$now" ]; then
    return 0
  fi
  printf "%s\n" "$now" >"$STATE_DIR/${safe_key}.${channel}"
}

sent=0
attempted=0
have_channel=0

# Telegram
TG_TOKEN_FILE="${TG_TOKEN_FILE:-/home/tim/scripts/.telegram-token}"
TG_CHAT_FILE="${TG_CHAT_FILE:-/home/tim/scripts/.telegram-chat-id}"
if [ -f "$TG_TOKEN_FILE" ] && [ -f "$TG_CHAT_FILE" ]; then
  have_channel=1
  if channel_in_cooldown telegram; then
    :
  else
    attempted=$((attempted + 1))
    TG_TOKEN=$(tr -d "\r\n" < "$TG_TOKEN_FILE")
    TG_CHAT=$(tr -d "\r\n" < "$TG_CHAT_FILE")
    if curl -sf --max-time 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_CHAT}" \
      --data-urlencode "text=${TEXT}" >/dev/null 2>&1; then
      sent=1
      stamp_channel telegram
    else
      alog "WARN telegram send failed key=${KEY:-none} tag=${TAG}"
      echo "alert.sh: telegram send failed" >&2
    fi
  fi
fi

# Slack
SLACK_FILE="${SLACK_FILE:-/home/tim/scripts/.slack-webhook}"
if [ -f "$SLACK_FILE" ]; then
  have_channel=1
  if channel_in_cooldown slack; then
    :
  else
    attempted=$((attempted + 1))
    SLACK_URL=$(tr -d "\r\n" < "$SLACK_FILE")
    payload=$(printf "{\"text\":%s}" "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$TEXT")")
    if curl -sf --max-time 10 -X POST -H "Content-type: application/json" \
      --data "$payload" "$SLACK_URL" >/dev/null 2>&1; then
      sent=1
      stamp_channel slack
    else
      alog "WARN slack send failed key=${KEY:-none} tag=${TAG}"
      echo "alert.sh: slack send failed" >&2
    fi
  fi
fi

if [ "$have_channel" -eq 0 ]; then
  alog "WARN no alert channels configured (missing telegram and/or slack files) key=${KEY:-none} tag=${TAG} msg=${MSG}"
  echo "alert.sh: no alert channels configured" >&2
  exit 0
fi

# Every configured channel still in cooldown — nothing to send.
if [ "$attempted" -eq 0 ]; then
  exit 0
fi

if [ "$sent" -eq 0 ]; then
  alog "WARN all attempted channels failed key=${KEY:-none} tag=${TAG}"
  echo "alert.sh: all channels failed" >&2
  exit 1
fi
