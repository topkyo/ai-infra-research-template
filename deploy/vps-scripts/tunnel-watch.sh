#!/usr/bin/env bash
# tunnel-watch.sh — 检测 Cloudflare Tunnel URL 变化，自动更新 Vercel 部署
# 由 cron 每 5 分钟调用，URL 未变化时秒退
#
# URL 来源优先级：
# 1) cloudflared entry 写入的状态文件（最可靠）
# 2) journalctl 最近日志
# 3) 状态文件内容 + /health 探活（兜底）

set -euo pipefail

TOKEN_FILE="/home/tim/scripts/.vercel-token"
REPO="/home/tim/project/EA"
STATE_FILE="/home/tim/scripts/.tunnel-url-state"
LOG_FILE="/home/tim/scripts/tunnel-watch.log"
ALERT_SCRIPT="/home/tim/scripts/alert.sh"
TOUCH_FILE="/home/tim/scripts/.tunnel-check-due"

log() {
  echo "$(date -Iseconds) $*" >> "$LOG_FILE"
}

normalize_url() {
  local url="$1"
  url=$(printf '%s' "$url" | tr -d '\r' | head -n 1)
  url="${url#"${url%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"
  if [[ "$url" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]]; then
    printf '%s' "$url"
    return 0
  fi
  return 1
}

probe_ok() {
  local url="$1"
  local body
  body=$(curl -sf --max-time 10 "${url}/health" 2>/dev/null || true)
  [ "$body" = '{"ok":true}' ]
}

# 从安全文件读取 Vercel token（权限 600）
if [ ! -f "$TOKEN_FILE" ]; then
  log "ERROR: token 文件 $TOKEN_FILE 不存在"
  exit 1
fi
VERCEL_TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")

CURRENT_URL=""

# 1) 状态文件（entry 启动时写入；不要求立刻探活，避免短暂抖动误判）
if [ -f "$STATE_FILE" ]; then
  if CANDIDATE=$(normalize_url "$(cat "$STATE_FILE" 2>/dev/null || true)"); then
    CURRENT_URL="$CANDIDATE"
  fi
fi

# 2) journalctl 最新 URL（覆盖状态文件，因重启后 URL 会变）
JOURNAL_URL=$(sudo journalctl -u cloudflared-tunnel --no-pager -n 300 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
if JOURNAL_URL=$(normalize_url "${JOURNAL_URL:-}" 2>/dev/null); then
  if [ -n "$JOURNAL_URL" ]; then
    if [ -z "$CURRENT_URL" ] || [ "$JOURNAL_URL" != "$CURRENT_URL" ]; then
      # journal 更新：优先采用 journal（新 URL），再探活确认
      if probe_ok "$JOURNAL_URL"; then
        CURRENT_URL="$JOURNAL_URL"
      elif [ -z "$CURRENT_URL" ]; then
        CURRENT_URL="$JOURNAL_URL"
      fi
    fi
  fi
fi

# 3) 若仍空或状态文件 URL 不可达，再做状态文件探活兜底
if [ -z "$CURRENT_URL" ] && [ -f "$STATE_FILE" ]; then
  if CANDIDATE=$(normalize_url "$(cat "$STATE_FILE" 2>/dev/null || true)"); then
    if probe_ok "$CANDIDATE"; then
      CURRENT_URL="$CANDIDATE"
      log "WARN: 使用状态文件 URL（探活通过）: $CURRENT_URL"
    fi
  fi
fi

if [ -z "$CURRENT_URL" ]; then
  log "ERROR: 无法获取 Tunnel URL（状态文件与 journal 均失败）"
  exit 1
fi

# 规范化后写回状态文件（保持落盘与真实一致）
printf '%s\n' "$CURRENT_URL" > "$STATE_FILE"

# 上次已同步到 Vercel 的 URL
LAST_SYNC_FILE="/home/tim/scripts/.tunnel-url-synced"
LAST_URL=""
if [ -f "$LAST_SYNC_FILE" ]; then
  LAST_URL=$(tr -d '\r\n' < "$LAST_SYNC_FILE" || true)
else
  # 兼容迁移：从 vercel.json 推断当前已部署 URL
  LAST_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
    "$REPO/apps/web/vercel.json" 2>/dev/null | head -1 || true)
  if [ -n "$LAST_URL" ]; then
    printf '%s\n' "$LAST_URL" > "$LAST_SYNC_FILE"
  fi
fi

# External tunnel health (every 30 minutes); URL-sync logic unchanged below.
DO_TUNNEL_HEALTH=1
if [ -f "$TOUCH_FILE" ]; then
  LAST=$(tr -d ' \t\r\n' < "$TOUCH_FILE" || true)
  NOW=$(date +%s)
  if [ -n "${LAST:-}" ] && [ "$LAST" -eq "$LAST" ] 2>/dev/null; then
    if [ $((NOW - LAST)) -lt 1800 ]; then
      DO_TUNNEL_HEALTH=0
    fi
  fi
fi
if [ "$DO_TUNNEL_HEALTH" -eq 1 ]; then
  if probe_ok "$CURRENT_URL"; then
    log "tunnel health OK: $CURRENT_URL"
  else
    log "ERROR: tunnel health FAILED: $CURRENT_URL"
    ALERT_TAG="[tunnel]" ALERT_KEY="tunnel-external" COOLDOWN_SEC=1800 \
      "$ALERT_SCRIPT" "Tunnel 外网 /health 失败: $CURRENT_URL" 2>/dev/null || true
  fi
  date +%s > "$TOUCH_FILE"
fi

# URL 未变化，秒退
if [ "$CURRENT_URL" = "$LAST_URL" ]; then
  exit 0
fi

log "URL 变化: ${LAST_URL:-<empty>} → $CURRENT_URL"

# 先重置 vercel.json 到 git 版本，避免本地修改残留
cd "$REPO"
sudo git checkout -- apps/web/vercel.json apps/site/vercel.json 2>/dev/null || true

# 更新 vercel.json 中的 tunnel URL
for proj in web site; do
  FILE="$REPO/apps/$proj/vercel.json"
  if [ -f "$FILE" ]; then
    sudo sed -i "s|https://[a-z0-9-]*\.trycloudflare\.com|$CURRENT_URL|g" "$FILE"
    sudo chown tim:tim "$FILE"
    log "更新 apps/$proj/vercel.json"
  fi
done

# 重新部署 Vercel 项目（限制内存避免 OOM）
VERCEL_SCOPE_ARGS=""
if [ -n "${VERCEL_ORG_ID:-}" ]; then
  VERCEL_SCOPE_ARGS="--scope $VERCEL_ORG_ID"
fi
for proj in web site; do
  log "部署 apps/$proj..."
  cd "$REPO/apps/$proj"
  # shellcheck disable=SC2086
  NODE_OPTIONS="--max-old-space-size=256" \
    VERCEL_TOKEN="$VERCEL_TOKEN" vercel --prod --yes --token "$VERCEL_TOKEN" $VERCEL_SCOPE_ARGS >> "$LOG_FILE" 2>&1 || \
    log "ERROR: apps/$proj 部署失败"
done

# 验证
sleep 5
HEALTH=$(curl -sf --max-time 10 "${CURRENT_URL}/health" 2>/dev/null || echo "FAILED")
log "验证 tunnel health: $HEALTH"

printf '%s\n' "$CURRENT_URL" > "$STATE_FILE"
printf '%s\n' "$CURRENT_URL" > "$LAST_SYNC_FILE"

# Commit vercel.json 改动回 GitHub，避免仓库与 VPS 不同步
cd "$REPO"
sudo -u tim git add apps/web/vercel.json apps/site/vercel.json 2>/dev/null || true
sudo -u tim git commit -m "chore(deploy): tunnel URL 自动更新为 $CURRENT_URL" 2>/dev/null && \
  sudo -u tim git push origin main 2>/dev/null && \
  log "vercel.json 已 commit 并 push 到 GitHub" || \
  log "vercel.json commit/push 跳过（无变化或失败）"

log "完成，URL 已更新为 $CURRENT_URL"
