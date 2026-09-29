#!/usr/bin/env bash
# Concurrency E2E for the xreactor redesign (run ON the VM).
#
# Fires 1 batch xreactor request (2 URLs => 2 isolated browsers on 2 private
# Xvfb displays) AND 1 regular /v1/scrape AT THE SAME MOMENT, then verifies:
#   - 3 distinct recordings, each covering ONLY its own session's window
#   - each xreactor video was grabbed on its own display (log evidence)
#   - log events are tagged with pageId == sessionId (per-session console)
#   - verdicts + timings are sane
set -uo pipefail
ROOT_DIR="/root/steel-browser"
LOG_FILE="${ROOT_DIR}/steel-api.log"
RECORDINGS_DIR="/data/recordings"
PORT=3000
TEST_URL="${1:-https://crackingx.com/threads/95694/}"

echo "=== 1) firing concurrent requests ==="
T0=$(date +%s.%N)

# xreactor batch: 2 URLs => 2 concurrent isolated browsers
curl -s --max-time 150 -X POST "http://127.0.0.1:${PORT}/xreactor" \
  -H "Host: xreactor-bot.duckdns.org" \
  -H "X-Xreactor-Edge: $(cat "${ROOT_DIR}/api/.env" | grep '^XREACTOR_EDGE_TOKEN=' | cut -d= -f2- | tr -d '"'"'"'')" \
  -H "Content-Type: application/json" \
  -d "{\"urls\":[\"${TEST_URL}\",\"https://t.me/cracxAds\"]}" -o /tmp/e2e-xr.json &
XR_PID=$!

# regular scrape on the shared pipeline, same instant
curl -s --max-time 150 -X POST "http://127.0.0.1:${PORT}/v1/scrape" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","format":["markdown"]}' -o /tmp/e2e-sc.json &
SC_PID=$!

wait $XR_PID $SC_PID
T1=$(date +%s.%N)
echo "total wall time: $(echo "$T1 - $T0" | bc)s"

echo
echo "=== 2) display acquisition evidence (log) ==="
grep -E "acquired display|no dedicated display" "${LOG_FILE}" | tail -4

echo
echo "=== 3) recordings created in this window ==="
NOW=$(date +%s)
find "${RECORDINGS_DIR}" -name '*.mp4' -mmin -5 -printf '%f %s bytes\n' 2>/dev/null | sort

echo
echo "=== 4) xreactor result summary ==="
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/e2e-xr.json'))
except Exception as e:
    print("FAILED to parse xreactor response:", e)
    raise SystemExit(1)
if 'results' in d:
    for r in d['results']:
        print(f"  {r['seedUrl']}: {r['result']} pages={len(r['pages'])} found={r['links']['found']} followed={len(r['links']['followed'])} totalMs={r['timings']['totalMs']} launchMs={r['timings'].get('launchMs')}")
    print("  summary:", d.get('summary'))
else:
    print(f"  {d.get('seedUrl')}: {d.get('result')} pages={len(d.get('pages', []))} totalMs={d.get('timings', {}).get('totalMs')}")

try:
    s = json.load(open('/tmp/e2e-sc.json'))
    md = (s.get('content') or {}).get('markdown') or ''
    print(f"  scrape: markdownChars={len(md)} ok")
except Exception as e:
    print("  scrape FAILED:", e)
PY

echo
echo "=== 5) session rows + per-session log pageIds ==="
python3 - <<'PY'
import json, subprocess, time
out = subprocess.run(['curl','-s','--max-time','10','http://127.0.0.1:3000/v1/sessions'], capture_output=True, text=True).stdout
d = json.loads(out)
rows = d.get('sessions', [])
recent = [r for r in rows if r.get('userAgent','').startswith('XReactor') or r.get('id')][:8]
for r in recent[:8]:
    print(f"  {r['id'][:8]} status={r.get('status')} dur={r.get('duration')}ms ua={(r.get('userAgent') or '')[:60]} logPageId={r.get('logPageId', (r['id'] if r.get('userAgent','').startswith('XReactor') else '-'))[:8]}")
# verify logs query with pageId returns only that session's events
for r in recent[:3]:
    pid = r.get('logPageId') or (r['id'] if (r.get('userAgent') or '').startswith('XReactor') else None)
    if not pid:
        continue
    q = subprocess.run(['curl','-s','--max-time','10',
        f"http://127.0.0.1:3000/v1/logs/query?pageId={pid}&limit=5"], capture_output=True, text=True).stdout
    try:
        evs = json.loads(q).get('events', [])
        types = {}
        for e in evs:
            t = (e.get('event') or e).get('type')
            types[t] = types.get(t, 0) + 1
        tag_ok = all((e.get('event') or e).get('pageId') == pid for e in evs)
        print(f"  logs pageId={pid[:8]} count={len(evs)} types={types} allMatchSession={tag_ok}")
    except Exception as ex:
        print(f"  logs pageId={pid[:8]} query failed: {ex}")
PY

echo
echo "=== 6) ffmpeg sources used (log) ==="
grep -E "xreactor.*display" "${LOG_FILE}" | tail -6
echo
echo "E2E script done."
