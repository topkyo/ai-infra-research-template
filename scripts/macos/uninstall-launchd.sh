#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="${HOME}/Library/LaunchAgents"
UID_GUI="gui/$(id -u)"

for label in com.topkyo.ai-infra.pyserver com.topkyo.ai-infra.web; do
  launchctl bootout "${UID_GUI}/${label}" 2>/dev/null || true
  rm -f "${AGENTS_DIR}/${label}.plist"
  echo "removed ${label}"
done

echo "Done. Logs remain in ~/Library/Logs/topkyo-ai-infra/"
