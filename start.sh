#!/usr/bin/env bash
# Start pyserver (FastAPI on :8001) and web (Next.js on :3000) together.
# Stale listeners that look like this stack are killed automatically. A foreign
# process on the port requires interactive confirmation (or FORCE_FREE_PORT=1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_PORT="${PY_PORT:-8001}"
WEB_PORT="${WEB_PORT:-3000}"

# Return 0 when the listener command looks like this repo's pyserver / web.
is_our_listener() {
  local label="$1" cmd="$2"
  case "$label" in
    pyserver)
      [[ "$cmd" == *uvicorn* ]] || [[ "$cmd" == *main:app* ]] || [[ "$cmd" == *"/pyserver"* ]]
      ;;
    web)
      [[ "$cmd" == *next* ]] \
        || [[ "$cmd" == *"npm run dev"* ]] \
        || [[ "$cmd" == *"$ROOT/web"* ]]
      ;;
    *)
      return 1
      ;;
  esac
}

kill_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  local _
  for _ in 1 2 3 4 5; do
    sleep 0.5
    kill -0 "$pid" 2>/dev/null || return 0
  done
  echo "[start] pid $pid did not exit, sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
}

free_port() {
  local port="$1" label="$2"
  local pids pid cmd
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  # lsof may return multiple PIDs (one per line).
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || echo "?")"
    if is_our_listener "$label" "$cmd"; then
      echo "[start] port $port ($label) busy with our stack (pid $pid) — killing"
      echo "[start]   $cmd"
      kill_pid "$pid"
      continue
    fi

    echo "[start] port $port ($label) busy with foreign process (pid $pid)"
    echo "[start]   $cmd"
    if [[ "${FORCE_FREE_PORT:-}" == "1" ]]; then
      echo "[start] FORCE_FREE_PORT=1 — killing foreign process"
      kill_pid "$pid"
      continue
    fi
    if [[ -t 0 ]]; then
      local ans=""
      read -r -p "[start] Kill it and continue? [y/N] " ans || true
      if [[ "$ans" == [yY] ]]; then
        kill_pid "$pid"
        continue
      fi
      echo "[start] aborting (port $port still held). Re-run with FORCE_FREE_PORT=1 to override."
      exit 1
    fi
    echo "[start] non-interactive and foreign listener — aborting."
    echo "[start] free the port or re-run with FORCE_FREE_PORT=1."
    exit 1
  done <<< "$pids"
}

free_port "$PY_PORT" pyserver
free_port "$WEB_PORT" web

cleanup() {
  echo "[start] shutting down"
  [[ -n "${PY_PID:-}" ]] && kill "$PY_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[start] launching pyserver on :$PY_PORT"
( cd "$ROOT/pyserver" && uv run uvicorn main:app --host 127.0.0.1 --port "$PY_PORT" ) &
PY_PID=$!

echo "[start] launching web on :$WEB_PORT"
( cd "$ROOT/web" && npm run dev -- --port "$WEB_PORT" ) &
WEB_PID=$!

wait -n "$PY_PID" "$WEB_PID"
