#!/usr/bin/env bash
# Debug: full JSON response for the t.me seed (shows links counters + page detail).
set -uo pipefail
ROOT_DIR="/root/steel-browser"
TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ROOT_DIR}/api/.env" | cut -d= -f2- | tr -d '"')

curl -s --max-time 120 -X POST http://127.0.0.1:3000/xreactor \
  -H "Host: xreactor-bot.duckdns.org" -H "X-Xreactor-Edge: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://t.me/cracxAds"}' | python3 -m json.tool
