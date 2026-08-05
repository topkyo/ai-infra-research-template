#!/usr/bin/env bash
# Reclaim Docker disk on small VPS roots (e.g. 狗云 20G).
# Safe defaults: never touch volumes or running containers.
# - builder prune: build cache left by compose/CI rebuilds
# - image prune -a: unused images (keeps only images referenced by running containers)
set -euo pipefail

LOG="${DOCKER_DISK_PRUNE_LOG:-$HOME/scripts/docker-disk-prune.log}"
mkdir -p "$(dirname "$LOG")"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

{
  echo "[$(ts)] docker-disk-prune start"
  df -h / | awk 'NR==1 || /\/$/'
  if ! command -v docker >/dev/null 2>&1; then
    echo "[$(ts)] ERROR docker not found"
    exit 1
  fi
  docker builder prune -af
  # Dangling + unused tagged images; does not remove images used by running containers.
  docker image prune -af
  echo "[$(ts)] docker system df"
  docker system df || true
  df -h / | awk 'NR==1 || /\/$/'
  echo "[$(ts)] docker-disk-prune done"
} >>"$LOG" 2>&1
