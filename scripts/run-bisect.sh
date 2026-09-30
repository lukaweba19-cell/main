#!/usr/bin/env bash
# Usage: run-bisect.sh PROFILE(0|1) EXT(0|1) TARGET
# PROFILE 0 = fresh clone, 1 = durable default profile.
# Reads NON-SECRET runtime knobs from the running API's /proc environ
# (NODRIVER_SIDECAR_PORT, STEEL_EXTENSIONS_DIR, NODE_ENV, DISPLAY, TZ) so a
# second sidecar instance doesn't collide with the production one on 9224.
# Token/env SECRET values are filtered out before use.
set -uo pipefail
P=$1; E=$2; T=$3
RESULT="/tmp/bisect-${P}-${E}.result"
LOG="/tmp/bisect-${P}-${E}.log"
rm -f "$RESULT" "$LOG"

API_PID=$(pgrep -f "node build/index.js" | head -1)
ENVARGS=""
if [[ -n "${API_PID}" ]]; then
  # Only allow-listed, non-secret keys pass through.
  for KEY in NODRIVER_SIDECAR_PORT STEEL_EXTENSIONS_DIR NODE_ENV DISPLAY TZ CHROME_EXECUTABLE_PATH; do
    VAL=$(tr '\0' '\n' < "/proc/${API_PID}/environ" 2>/dev/null | grep "^${KEY}=" | cut -d= -f2-)
    if [[ -n "$VAL" ]]; then ENVARGS="$ENVARGS $KEY=$VAL"; fi
  done
fi

cd /root/steel-browser/api
# Own sidecar port (9226): never contend with the production sidecar on 9224.
env $ENVARGS NODRIVER_SIDECAR_PORT=9226 PROFILE=$P EXT=$E TARGET="$T" timeout 150 node bisect.mjs > "$LOG" 2>&1
EC=$?
{ echo "NODE_EXIT:$EC"; grep -vi warning "$LOG" | head -30; } > "$RESULT" 2>&1
