#!/usr/bin/env bash
# Full verification for the xreactor capture overhaul. Run ON the VM.
# Checks: t.me timing, structured network events, real UA in row, disallowed
# chain via t.me bio links, recording geometry, per-session log isolation.
set -uo pipefail
ROOT_DIR="/root/steel-browser"
TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ROOT_DIR}/api/.env" | cut -d= -f2- | tr -d '"')
PORT=3000

xr() {
  curl -s --max-time 150 -X POST "http://127.0.0.1:${PORT}/xreactor" \
    -H "Host: xreactor-bot.duckdns.org" -H "X-Xreactor-Edge: ${TOKEN}" \
    -H "Content-Type: application/json" -d "$1"
}

echo "=== 1) t.me single check (should be ~10s, not 30+) ==="
xr '{"url":"https://t.me/cracxAds"}' > /tmp/v-single.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/v-single.json'))
p = d['pages'][0]
print(f"  result={d['result']} navMs={p['navMs']} readyMs={p['readyMs']} totalMs={d['timings']['totalMs']}")
PY
SID1=$(python3 -c "import json;print(json.load(open('/tmp/v-single.json'))['pages'][0].get('sessionId','none'))" 2>/dev/null || echo none)

echo
echo "=== 2) session row: real user agent + fields ==="
python3 - <<'PY'
import json, subprocess
rows = json.loads(subprocess.run(['curl','-s','--max-time','10','http://127.0.0.1:3000/v1/sessions'],capture_output=True,text=True).stdout)['sessions']
xr_rows = [r for r in rows if r.get('logPageId')]
r = xr_rows[0]
print(f"  ua={r.get('userAgent','')[:70]}")
print(f"  viewport={r.get('viewport')} dims={r.get('dimensions')} logPageId={(r.get('logPageId') or '')[:8]}")
assert r.get('userAgent','').startswith('Mozilla/5.0'), "UA IS NOT A REAL BROWSER UA"
print("  UA OK (real browser user agent, no verdict prefix)")
PY

echo
echo "=== 3) network events: structured shapes with urls ==="
python3 - <<'PY'
import json, subprocess
rows = json.loads(subprocess.run(['curl','-s','--max-time','10','http://127.0.0.1:3000/v1/sessions'],capture_output=True,text=True).stdout)['sessions']
pid = [r for r in rows if r.get('logPageId')][0]['logPageId']
q = json.loads(subprocess.run(['curl','-s','--max-time','10',
    f'http://127.0.0.1:3000/v1/logs/query?pageId={pid}&limit=100'],capture_output=True,text=True).stdout)
evs = q.get('events', [])
types = {}
urls_present = 0
req_res = 0
for e in evs:
    types[e.get('type')] = types.get(e.get('type'), 0) + 1
    if e.get('request', {}).get('url') or e.get('response', {}).get('url') or e.get('navigation', {}).get('url'):
        urls_present += 1
    if e.get('request') and e.get('request').get('method'):
        req_res += 1
print(f"  total={q.get('total')} types={types}")
print(f"  events with structured url fields: {urls_present}")
print(f"  Request events with method+url: {req_res}")
sample = next((e for e in evs if e.get('request')), None)
if sample:
    print(f"  sample Request: {sample['request'].get('method')} {sample['request'].get('url','')[:70]}")
sample = next((e for e in evs if e.get('response')), None)
if sample:
    print(f"  sample Response: {sample['response'].get('status')} {sample['response'].get('url','')[:70]}")
PY

echo
echo "=== 4) disallowed chain (crackingx -> t.me/x_d9v -> usrlnk.io/eaglecloud) ==="
xr '{"url":"https://crackingx.com/threads/95694/"}' > /tmp/v-chain.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/v-chain.json'))
print(f"  verdict={d['result']} pages={len(d['pages'])} followed={len(d['links']['followed'])}")
for p in d['pages']:
    print(f"    {p['url'][:60]} -> {p['status']} cloud={p['cloudFound']} readyMs={p.get('readyMs')}")
PY

echo
echo "=== 5) recording geometry of newest xreactor video ==="
python3 - <<'PY'
import json, subprocess
rows = json.loads(subprocess.run(['curl','-s','--max-time','10','http://127.0.0.1:3000/v1/sessions'],capture_output=True,text=True).stdout)['sessions']
pid = [r for r in rows if r.get('logPageId')][0]['logPageId']
out = subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',f'/data/recordings/{pid}.mp4'],capture_output=True,text=True).stdout.strip()
print(f"  {pid[:8]}: {out}  (expect 1440,950)")
PY

echo
echo "=== 6) Xvfb leftovers ==="
ps aux | grep '[X]vfb :' | grep -v ':10 ' || echo "  none-extra"
echo
echo "verification done"
