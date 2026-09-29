#!/usr/bin/env bash
# Verifies the follow-chain detection still works: t.me/cracxAds links to
# t.me/x_d9v whose content contains "eaglecloud" => verdict must be disallowed.
set -uo pipefail
ROOT_DIR="/root/steel-browser"
TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ROOT_DIR}/api/.env" | cut -d= -f2- | tr -d '"')

curl -s --max-time 120 -X POST http://127.0.0.1:3000/xreactor \
  -H "Host: xreactor-bot.duckdns.org" \
  -H "X-Xreactor-Edge: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://t.me/cracxAds"}' -o /tmp/e2e-follow.json

python3 - <<'PY'
import json
d = json.load(open('/tmp/e2e-follow.json'))
print('verdict:', d['result'])
for p in d['pages']:
    print('  page:', p['url'], '->', p['status'], 'cloudFound=', p['cloudFound'], 'matches=', [m['variant'] for m in p['matches']][:3])
print('followed:', d['links']['followed'], 'found:', d['links']['found'])
PY
