#!/usr/bin/env bash
# Runs the pulsetic probe detached; writes results to /tmp/pulsetic-probe.result
# The probe allocates its OWN display via the production acquireXvfbDisplay()
# allocator — fully concurrent with live sessions/scrapes.
set -uo pipefail
RESULT=/tmp/pulsetic-probe.result
rm -f "$RESULT" /tmp/pulsetic-probe.done
cd /root/steel-browser/api
timeout 100 node probe-pulsetic.mjs > /tmp/pulsetic-probe.log 2>&1
EC=$?
rm -rf /tmp/probe-pulsetic-*
{
  echo "NODE_EXIT:$EC"
  echo "=== PROBE OUTPUT ==="
  grep -vi warning /tmp/pulsetic-probe.log | head -40
} > "$RESULT" 2>&1
echo done > /tmp/pulsetic-probe.done
