#!/usr/bin/env bash
# Verifies detection end-to-end on both ends of the historical chain:
#   t.me/x_d9v            -> contains "cloud"  => verdict MUST be disallowed
#   t.me/cracxAds         -> loads clean        => verdict must be allowed
# (the bio-link from cracxAds to x_d9v disappeared upstream, so the chain is
# no longer followable; we pin the two endpoints directly instead)
set -uo pipefail
ROOT_DIR="/root/steel-browser"
TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ROOT_DIR}/api/.env" | cut -d= -f2- | tr -d '"')
FAIL=0

check() {
  local url="$1" expect="$2" out="$3"
  curl -s --max-time 120 -X POST http://127.0.0.1:3000/xreactor \
    -H "Host: xreactor-bot.duckdns.org" \
    -H "X-Xreactor-Edge: ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${url}\"}" -o "${out}"
  URL="${url}" EXPECT="${expect}" OUT="${out}" python3 - <<'PY'
import json, os
d = json.load(open(os.environ['OUT']))
verdict = d.get('result')
pages = d.get('pages', [])
ok = verdict == os.environ['EXPECT'] and pages and all(p['status'] == 'ok' for p in pages)
print(f"{os.environ['URL']}: verdict={verdict} (expected {os.environ['EXPECT']}) "
      f"pages={[(p['url'], p['status'], p['cloudFound']) for p in pages]} "
      f"=> {'PASS' if ok else 'FAIL'}")
if not ok:
    raise SystemExit(1)
PY
  [ $? -ne 0 ] && FAIL=1
}

check "https://t.me/x_d9v" disallowed /tmp/e2e-follow-xd9v.json || true
check "https://t.me/cracxAds" allowed /tmp/e2e-follow-cracx.json || true

if [ "${FAIL}" = "0" ]; then
  echo "FOLLOW-VERIFY: PASS"
else
  echo "FOLLOW-VERIFY: FAIL"
  exit 1
fi
