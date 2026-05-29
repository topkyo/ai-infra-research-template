#!/usr/bin/env bash
# Topkyo dashboard monitor: signals / backtest / universe-refresh + daily log rotation.
# Logs & state live under <repo>/.monitor/ (override with MONITOR_LOG_DIR / MONITOR_STATE).
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${MONITOR_LOG_DIR:-$ROOT/.monitor/logs}"
LOG_KEEP_DAYS="${MONITOR_LOG_KEEP_DAYS:-7}"
STATE="${MONITOR_STATE:-$ROOT/.monitor/state.env}"
WEB_PORT="${WEB_PORT:-3000}"
PY_PORT="${PY_PORT:-8001}"
WEB_PID_FIXED="${WEB_PID:-}"
WEB_PID="$WEB_PID_FIXED"
INTERVAL="${MONITOR_INTERVAL:-2}"
WEB_CWD_MARKER="${MONITOR_WEB_CWD:-$ROOT/web}"

refresh_web_pid() {
  [ -n "$WEB_PID_FIXED" ] && return
  WEB_PID="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
}

resolve_terminals_dir() {
  if [ -n "${CURSOR_TERMINALS_DIR:-}" ] && [ -d "$CURSOR_TERMINALS_DIR" ]; then
    printf '%s' "$CURSOR_TERMINALS_DIR"
    return
  fi
  local derived candidate d f
  derived="$HOME/.cursor/projects/$(echo "$ROOT" | sed 's/^\///' | tr '/' '-')"
  candidate="$derived/terminals"
  if [ -d "$candidate" ]; then
    printf '%s' "$candidate"
    return
  fi
  for d in "$HOME/.cursor/projects"/*/terminals; do
    [ -d "$d" ] || continue
    for f in "$d"/*.txt; do
      [ -f "$f" ] || continue
      if grep -Fq "$WEB_CWD_MARKER" "$f" 2>/dev/null; then
        printf '%s' "$d"
        return
      fi
    done
  done
  printf '%s' "$candidate"
}

TERMINALS_DIR="$(resolve_terminals_dir)"

BACKTEST_PEAK_PY="${BACKTEST_PEAK_PY:-14}"
BACKTEST_MIN_SEC="${BACKTEST_MIN_SEC:-90}"
BACKTEST_LLM_WAVES="${BACKTEST_LLM_WAVES:-3}"
CONN_LOG_EVERY="${MONITOR_CONN_LOG_EVERY:-15}" # seconds between conn snapshots during a run

RUN_KIND=idle
RUNNING=0
PHASE=idle
prev_py=0
prev_node_ext=0
peak_py=0
idle_ticks=0
llm_waves=0
llm_active=0
loading_done=0
run_start_epoch=0
last_conn_log=0
simulating_logged=0
LOG=""
LOG_DAY=""

mkdir -p "$LOG_DIR"
prune_old_logs() {
  find "$LOG_DIR" -maxdepth 1 -name '*.log' -mtime +"$LOG_KEEP_DAYS" -delete 2>/dev/null || true
}

resolve_log_file() {
  local today
  today=$(date +%Y-%m-%d)
  if [ "$LOG_DAY" != "$today" ]; then
    LOG_DAY=$today
    LOG="$LOG_DIR/$today.log"
    prune_old_logs
    ln -sf "$today.log" "$LOG_DIR/current.log"
    printf '%s MONITOR [idle] log rotate -> %s (keep %sd)\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" "$LOG" "$LOG_KEEP_DAYS" >>"$LOG"
  fi
}

log() {
  resolve_log_file
  local tag="${1:-$RUN_KIND}"
  shift
  printf '%s MONITOR [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$tag" "$*" >>"$LOG"
}

probe_http() {
  local name=$1 url=$2
  local out
  out=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code} %{time_total}' "$url" 2>&1) || out="FAIL $out"
  log idle "probe $name -> $out"
}

probe_llm() {
  local web_env="$ROOT/web/.env.local"
  [ -f "$web_env" ] || web_env="$ROOT/web/.env"
  if [ ! -f "$web_env" ]; then
    log idle "llm probe skip: no env file"
    return
  fi
  # shellcheck disable=SC1090
  set -a; source "$web_env" 2>/dev/null || true; set +a
  local url="${OPENCODE_GO_BASE_URL:-https://opencode.ai/zen/go/v1}/models"
  local key="${OPENCODE_GO_API_KEY:-}"
  if [ -z "$key" ] || [ "$key" = "mock" ]; then
    url="${DEEPSEEK_BASE_URL:-https://api.deepseek.com}/models"
    key="${DEEPSEEK_API_KEY:-}"
  fi
  [ -n "$key" ] || { log idle "llm probe skip: no API key"; return; }
  local proxy_args=()
  [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] && proxy_args=(--proxy "${HTTPS_PROXY:-${https_proxy}}")
  [ "${#proxy_args[@]}" -eq 0 ] && [ -n "${ALL_PROXY:-${all_proxy:-}}" ] && proxy_args=(--proxy "${ALL_PROXY:-${all_proxy}}")
  local code
  code=$(curl -sS "${proxy_args[@]}" --max-time 15 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $key" "$url" 2>&1) || code="FAIL:$code"
  log idle "llm models -> $code"
}

snapshot_connections() {
  local py_est=0 web_est=0 node_ext=0
  py_est=$(lsof -nP -iTCP:"$PY_PORT" -sTCP:ESTABLISHED 2>/dev/null | wc -l | tr -d ' ')
  web_est=$(lsof -nP -iTCP:"$WEB_PORT" -sTCP:ESTABLISHED 2>/dev/null | wc -l | tr -d ' ')
  if [ -n "${WEB_PID:-}" ]; then
    node_ext=$(lsof -nP -a -p "$WEB_PID" -iTCP:443 -sTCP:ESTABLISHED 2>/dev/null | wc -l | tr -d ' ')
  fi
  printf '%s %s %s\n' "${py_est:-0}" "${web_est:-0}" "${node_ext:-0}"
}

find_next_terminal() {
  local f
  [ -d "$TERMINALS_DIR" ] || return 1
  for f in "$TERMINALS_DIR"/*.txt; do
    [ -f "$f" ] || continue
    grep -Fq "$WEB_CWD_MARKER" "$f" 2>/dev/null || continue
    grep -qE 'next dev|next-server' "$f" 2>/dev/null || continue
    printf '%s' "$f"
    return 0
  done
  return 1
}

detect_route_from_next_log() {
  local term now mtime line kind=""
  term=$(find_next_terminal) || return 1
  mtime=$(stat -f %m "$term" 2>/dev/null) || return 1
  now=$(date +%s)
  [ "$((now - mtime))" -le 30 ] || return 1
  line=$(tail -40 "$term" 2>/dev/null | grep -E 'POST /api/(signals|backtest|universe/refresh)' | tail -1) || return 1
  case "$line" in
    *"POST /api/backtest"*) kind=backtest ;;
    *"POST /api/signals"*) kind=signals ;;
    *"POST /api/universe/refresh"*) kind=universe ;;
    *) return 1 ;;
  esac
  printf '%s' "$kind"
}

infer_kind_heuristic() {
  local elapsed=$(( $(date +%s) - run_start_epoch ))
  if [ "$peak_py" -ge "$BACKTEST_PEAK_PY" ]; then printf 'backtest'; return 0; fi
  if [ "$llm_waves" -ge "$BACKTEST_LLM_WAVES" ]; then printf 'backtest'; return 0; fi
  if [ "$elapsed" -ge "$BACKTEST_MIN_SEC" ] && [ "$llm_active" -eq 1 ]; then printf 'backtest'; return 0; fi
  # universe: LLM-first, low py peak, optional later py validation bursts
  if [ "$peak_py" -le 8 ] && [ "$llm_active" -eq 1 ] && [ "$loading_done" -eq 0 ]; then printf 'universe'; return 0; fi
  if [ "$loading_done" -eq 1 ] && [ "$llm_waves" -le 1 ] && [ "$elapsed" -le 180 ]; then printf 'signals'; return 0; fi
  return 1
}

resolve_run_kind() {
  local detected=""
  if detected=$(detect_route_from_next_log); then
    RUN_KIND=$detected
    log "$RUN_KIND" "route from Next log"
    return
  fi
  [ "$RUN_KIND" = "unknown" ] || return 0
  if detected=$(infer_kind_heuristic); then
    RUN_KIND=$detected
    log "$RUN_KIND" "route inferred peak_py=$peak_py llm_waves=$llm_waves elapsed=$(( $(date +%s) - run_start_epoch ))s"
  fi
}

track_llm() {
  if [ "$node_ext" -ge 1 ]; then
    llm_active=1
    if [ "${prev_node_ext:-0}" -eq 0 ]; then
      llm_waves=$((llm_waves + 1))
      log "${RUN_KIND:-unknown}" "PHASE llm wave=$llm_waves node_443=$node_ext"
    fi
  fi
}

maybe_log_conn() {
  local now=$1
  [ "$RUNNING" -eq 1 ] || return
  if [ "$py_est" != "$prev_py" ] || [ "$node_ext" != "$prev_node_ext" ]; then
    log "${RUN_KIND:-unknown}" "conn py=$py_est web=$web_est node_443=$node_ext phase=$PHASE"
    last_conn_log=$now
    return
  fi
  [ "$((now - last_conn_log))" -ge "$CONN_LOG_EVERY" ] || return
  log "${RUN_KIND:-unknown}" "conn py=$py_est web=$web_est node_443=$node_ext phase=$PHASE"
  last_conn_log=$now
}

write_state() {
  mkdir -p "$LOG_DIR"
  mkdir -p "$(dirname "$STATE")"
  printf 'kind=%s phase=%s running=%s peak_py=%s llm_waves=%s llm_active=%s log=%s\n' \
    "$RUN_KIND" "$PHASE" "$RUNNING" "$peak_py" "$llm_waves" "$llm_active" \
    "${LOG_DIR}/current.log" >"$STATE"
}

reset_run() {
  RUNNING=0
  RUN_KIND=idle
  PHASE=idle
  peak_py=0
  idle_ticks=0
  llm_waves=0
  llm_active=0
  loading_done=0
  run_start_epoch=0
  scoring_started=0
  simulating_logged=0
  write_state
}

start_run() {
  RUNNING=1
  RUN_KIND=unknown
  PHASE=loading
  peak_py=$py_est
  run_start_epoch=$(date +%s)
  last_conn_log=$run_start_epoch
  llm_waves=0
  llm_active=0
  loading_done=0
  scoring_started=0
  simulating_logged=0
  resolve_run_kind
  if [ "$node_ext" -ge 1 ] && [ "$py_est" -lt 2 ]; then
    PHASE=propose
    log "${RUN_KIND:-unknown}" "PHASE start (LLM-first) node_443=$node_ext"
  else
    log "${RUN_KIND:-unknown}" "PHASE start py=$py_est web=$web_est node_443=$node_ext"
  fi
}

resolve_log_file
ln -sf "$(basename "$LOG")" "$LOG_DIR/current.log"
refresh_web_pid

log idle "=== started pid=$$ web_pid=${WEB_PID:-none} log_dir=$LOG_DIR keep=${LOG_KEEP_DAYS}d"
log idle "tail -f $LOG_DIR/current.log"
probe_http pyserver-health "http://127.0.0.1:$PY_PORT/health"
probe_http web-home "http://127.0.0.1:$WEB_PORT/"
probe_llm
reset_run

while true; do
  resolve_log_file
  refresh_web_pid
  py_est=0 web_est=0 node_ext=0
  read -r py_est web_est node_ext < <(snapshot_connections) || true
  py_est=${py_est:-0}; web_est=${web_est:-0}; node_ext=${node_ext:-0}
  now=$(date +%s)

  if [ "$RUNNING" -eq 0 ]; then
    if [ "$py_est" -ge 2 ] || { [ "$web_est" -ge 2 ] && [ "$node_ext" -ge 1 ]; }; then
      start_run
    fi
  fi

  if [ "$RUNNING" -eq 1 ]; then
    [ "$RUN_KIND" = "unknown" ] && resolve_run_kind
    [ "$py_est" -gt "$peak_py" ] && peak_py=$py_est
    track_llm

    case "$RUN_KIND" in
      universe)
        if [ "$llm_active" -eq 1 ] && [ "$loading_done" -eq 0 ] && [ "$PHASE" = "loading" ]; then
          PHASE=propose
          log universe "PHASE propose (LLM pool refresh)"
        fi
        if [ "$py_est" -ge 1 ] && [ "$PHASE" = "propose" ]; then
          loading_done=1
          PHASE=validate
          log universe "PHASE validate py=$py_est"
        fi
        ;;
      *)
        if [ "$peak_py" -ge 2 ] && [ "$py_est" -le 1 ] && [ "$prev_py" -ge 2 ] && [ "$loading_done" -eq 0 ]; then
          loading_done=1
          PHASE=scoring
          resolve_run_kind
          log "${RUN_KIND:-unknown}" "PHASE loading->scoring peak=$peak_py"
        fi
        if [ "$RUN_KIND" = "backtest" ] && [ "$PHASE" = "scoring" ] && [ "$py_est" -eq 0 ] && [ "$node_ext" -eq 0 ] \
           && [ "$web_est" -ge 2 ] && [ "$prev_node_ext" -ge 1 ] && [ "$simulating_logged" -eq 0 ]; then
          simulating_logged=1
          PHASE=simulating
          log backtest "PHASE simulating"
        fi
        ;;
    esac

    if [ "$py_est" -eq 0 ] && [ "$web_est" -le 1 ]; then
      idle_ticks=$((idle_ticks + 1))
      if [ "$idle_ticks" -ge 3 ]; then
        log "${RUN_KIND:-unknown}" "PHASE done elapsed=$(( now - run_start_epoch ))s peak_py=$peak_py llm_waves=$llm_waves"
        reset_run
      fi
    else
      idle_ticks=0
    fi

    maybe_log_conn "$now"
    write_state
  fi

  prev_py=$py_est
  prev_node_ext=$node_ext
  sleep "$INTERVAL"
done
