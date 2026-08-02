#!/usr/bin/env bash
# alert.sh — Telegram + Slack with tag and cooldown
# Usage:
#   alert.sh "message"
#   ALERT_TAG=proxy ALERT_KEY=sing-box COOLDOWN_SEC=1800 alert.sh "sing-box down"
# Cooldown stamp is written only after at least one channel accepts the send.
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

if [ -n "$KEY" ] && [ "$COOLDOWN_SEC" -gt 0 ] 2>/dev/null; then
  safe_key=$(printf "%s" "$KEY" | tr -c "A-Za-z0-9._-" "_")
  stamp_file="$STATE_DIR/$safe_key"
  now=$(date +%s)
  if [ -f "$stamp_file" ]; then
    last=$(tr -d " \t\r\n" < "$stamp_file" || true)
    if [ -n "${last:-}" ] && [ "$last" -eq "$last" ] 2>/dev/null; then
      if [ $((now - last)) -lt "$COOLDOWN_SEC" ]; then
        exit 0
      fi
    fi
  fi
else
  stamp_file=""
  now=""
fi

sent=0
have_channel=0

# Telegram
TG_TOKEN_FILE="${TG_TOKEN_FILE:-/home/tim/scripts/.telegram-token}"
TG_CHAT_FILE="${TG_CHAT_FILE:-/home/tim/scripts/.telegram-chat-id}"
if [ -f "$TG_TOKEN_FILE" ] && [ -f "$TG_CHAT_FILE" ]; then
  have_channel=1
  TG_TOKEN=$(tr -d "\r\n" < "$TG_TOKEN_FILE")
  TG_CHAT=$(tr -d "\r\n" < "$TG_CHAT_FILE")
  if curl -sf --max-time 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${TEXT}" >/dev/null 2>&1; then
    sent=1
  else
    alog "WARN telegram send failed key=${KEY:-none} tag=${TAG}"
    echo "alert.sh: telegram send failed" >&2
  fi
fi

# Slack
SLACK_FILE="${SLACK_FILE:-/home/tim/scripts/.slack-webhook}"
if [ -f "$SLACK_FILE" ]; then
  have_channel=1
  SLACK_URL=$(tr -d "\r\n" < "$SLACK_FILE")
  payload=$(printf "{\"text\":%s}" "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$TEXT")")
  if curl -sf --max-time 10 -X POST -H "Content-type: application/json" \
    --data "$payload" "$SLACK_URL" >/dev/null 2>&1; then
    sent=1
  else
    alog "WARN slack send failed key=${KEY:-none} tag=${TAG}"
    echo "alert.sh: slack send failed" >&2
  fi
fi

if [ "$have_channel" -eq 0 ]; then
  alog "WARN no alert channels configured (missing telegram and/or slack files) key=${KEY:-none} tag=${TAG} msg=${MSG}"
  echo "alert.sh: no alert channels configured" >&2
  exit 0
fi

# Only suppress retries after a successful delivery on at least one channel.
if [ "$sent" -eq 1 ] && [ -n "${stamp_file:-}" ] && [ -n "${now:-}" ]; then
  printf "%s\n" "$now" > "$stamp_file"
elif [ "$sent" -eq 0 ]; then
  alog "WARN all configured channels failed key=${KEY:-none} tag=${TAG}"
  echo "alert.sh: all channels failed" >&2
  exit 1
fi
