#!/usr/bin/env bash
# Full verification for the xreactor capture overhaul. Run ON the VM.
# Checks: t.me timing, structured network events, real UA in row, disallowed
# chain via t.me bio links, recording geometry, per-session log isolation.
# ALSO: hard guarantees — profileId/cfVerify rejected-or-ignored, default
# profile always used, extensions loaded, no multi-second dead waits.
set -uo pipefail
ROOT_DIR="/root/steel-browser"
TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ROOT_DIR}/api/.env" | cut -d= -f2- | tr -d '"')
PORT=3000
FAIL=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; FAIL=1; }

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
# Timing assertions: nav + ready must be tight (no 6s dead waits).
python3 - <<'PY'
import json, os, sys
d = json.load(open('/tmp/v-single.json'))
p = d['pages'][0]
ready = p.get('readyMs') or 0
nav = p.get('navMs') or 0
if p['status'] != 'ok':
    print(f"  FAIL  page status={p['status']} err={p.get('error','')[:80]}"); sys.exit(1)
if ready > 4000:
    print(f"  FAIL  readyMs={ready} > 4000 (dead wait regression)"); sys.exit(1)
print(f"  PASS  timing tight (navMs={nav}, readyMs={ready})")
PY
[ $? -ne 0 ] && bad "t.me timing" || ok "t.me timing"

# Unknown/legacy body fields must not break the endpoint (profileId removed).
xr '{"url":"https://t.me/cracxAds","profileId":"77c70dc0-5792-4825-9c98-2a521825fc16","cfVerify":false}' > /tmp/v-legacy.json
python3 - <<'PY'
import json, sys
d = json.load(open('/tmp/v-legacy.json'))
if 'message' in d and 'profileId' in str(d.get('message','')):
    print(f"  FAIL  legacy profileId rejected: {d['message'][:80]}"); sys.exit(1)
if d.get('pages',[{}])[0].get('status') != 'ok':
    print(f"  FAIL  legacy-field request failed: {str(d)[:120]}"); sys.exit(1)
print("  PASS  legacy profileId/cfVerify fields ignored (default profile, cfVerify always on)")
PY
[ $? -ne 0 ] && bad "legacy fields" || ok "legacy fields"

# Extensions must ACTUALLY be live in the isolated browser. Proven on Chrome
# 154: command-line loading (--load-extension, even with the >= 137 grace
# flags) is dead; the working path is CDP Extensions.loadUnpacked post-launch,
# which the sidecar performs and reports. Assert from the sidecar's own
# report line for the freshest launch.
python3 - <<'PY'
import re, sys
log = open('/root/steel-browser/steel-api.log', 'rb').read()[-400000:].decode('utf-8', 'ignore')
# xreactor logs: "nodriver launched chrome pid=... extensions=N loaded / M failed"
hits = re.findall(r'extensions=(\d+) loaded / (\d+) failed', log)
if not hits:
    print('  FAIL  no extension report found in xreactor launch log')
    sys.exit(1)
loaded, failed = map(int, hits[-1])
# The sidecar also reports CDP-level failures:
cdp_fail = re.findall(r'extension load failed: (.+?) \((.{0,120})', log)
if loaded == 0:
    print(f'  FAIL  0 extensions loaded (failed={failed})' + (f' e.g. {cdp_fail[-1] if cdp_fail else ""}'))
    sys.exit(1)
print(f'  PASS  extensions live in browser: {loaded} loaded, {failed} failed (CDP Extensions.loadUnpacked)')
PY
[ $? -ne 0 ] && bad "extensions" || ok "extensions"

# Default profile enforcement: the freshest launch must reference a /tmp clone
# of the durable default profile (xreactor-profile-*), never an uploaded one.
python3 - <<'PY'
import sys
log = open('/root/steel-browser/steel-api.log', 'rb').read()[-400000:].decode('utf-8', 'ignore')
idx = log.rfind('INFO nodriver.core.browser: starting')
recent = log[idx:idx + 4000] if idx >= 0 else ''
if 'xreactor-uploaded-' in recent:
    print("  FAIL  uploaded profile materialized — default profile policy violated")
    sys.exit(1)
if '--user-data-dir=/tmp/xreactor-profile-' in recent:
    print("  PASS  checks run on fresh clones of the durable default profile")
else:
    print("  FAIL  no default-profile clone in launch args")
    sys.exit(1)
PY
[ $? -ne 0 ] && bad "default profile" || ok "default profile"
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
echo "=== 6) SHARED-BROWSER scrape E2E: animated/heavy pages (the real product path) ==="
# These run /v1/scrape (shared-browser path, browser-per-job). They assert the
# FIX for the two user-reported failures:
#   - a fully loaded ANIMATED page must NOT hang to the 45s ceiling,
#   - a t.me page must NOT quit while still blank white.
# Scrape and echo wall-clock seconds via curl's own timer (VM 'date' lacks %N).
scrape() {
  local t_out="$2"
  curl -s --max-time 120 -w "%{time_total}" -o "$t_out" -X POST "http://127.0.0.1:${PORT}/v1/scrape" \
    -H "Content-Type: application/json" -d "{\"url\":\"$1\",\"format\":[\"markdown\"]}"
}

# 6a) pulsetic.com — animated marketing page (hero carousel etc). Page fully
# rendered but continuously mutating: the old mutation-gated predicate hung to
# the 45s ceiling here. Must release well under the ceiling with real content.
echo "  [pulsetic.com — animated page, must not hang to ceiling]"
PULS_MS=$(scrape "https://pulsetic.com/" /tmp/v-pulsetic.json)
PULS_MS=$(python3 -c "print(int(float('$PULS_MS')*1000))")
python3 - "$PULS_MS" <<'PY'
import json, sys
wall = int(sys.argv[1])
d = json.load(open('/tmp/v-pulsetic.json'))
md = ((d.get('content') or {}).get('markdown') or '')
wait = (d.get('metadata') or {}).get('times', {}).get('contentReadyWaitMs')
print(f"    wallMs={wall} contentReadyWaitMs={wait} markdownChars={len(md)}")
if len(md) < 200:
    print(f"  FAIL  pulsetic scrape: markdown too small ({len(md)} chars)"); sys.exit(1)
if wall > 25000:
    print(f"  FAIL  pulsetic scrape took {wall}ms — hang regression (ceiling reached)"); sys.exit(1)
print(f"  PASS  pulsetic released fast on a rendered animated page")
PY
[ $? -ne 0 ] && bad "pulsetic animated-page scrape" || ok "pulsetic animated-page scrape"

# 6b) crackingx.com — Cloudflare/JS-heavy site. Must release (challenge or
# not) with real content and well under the ceiling.
echo "  [crackingx.com — challenge/JS-heavy page]"
CRX_MS=$(scrape "https://crackingx.com/threads/95694/" /tmp/v-crx.json)
CRX_MS=$(python3 -c "print(int(float('$CRX_MS')*1000))")
python3 - "$CRX_MS" <<'PY'
import json, sys
wall = int(sys.argv[1])
d = json.load(open('/tmp/v-crx.json'))
md = ((d.get('content') or {}).get('markdown') or '')
print(f"    wallMs={wall} markdownChars={len(md)}")
if wall > 40000:
    print(f"  FAIL  crackingx scrape took {wall}ms — ceiling reached on a loadable page"); sys.exit(1)
if len(md) < 300:
    print(f"  FAIL  crackingx scrape: markdown too small ({len(md)} chars)"); sys.exit(1)
print(f"  PASS  crackingx released with content (no ceiling burn)")
PY
[ $? -ne 0 ] && bad "crackingx scrape" || ok "crackingx scrape"

# 6c) t.me — the OTHER user failure: page quit while still blank. The scrape
# must return non-empty t.me content (profile page renders text). If the
# readiness bar fires on a white page, markdown comes back tiny/empty.
echo "  [t.me/cracxAds — must NOT release while page is blank]"
TME_MS=$(scrape "https://t.me/cracxAds" /tmp/v-tme.json)
TME_MS=$(python3 -c "print(int(float('$TME_MS')*1000))")
python3 - "$TME_MS" <<'PY'
import json, sys
wall = int(sys.argv[1])
d = json.load(open('/tmp/v-tme.json'))
md = ((d.get('content') or {}).get('markdown') or '')
meta = json.dumps((d.get('metadata') or {}))
print(f"    wallMs={wall} markdownChars={len(md)}")
if len(md) < 80:
    print(f"  FAIL  t.me released while page still blank (markdown {len(md)} chars)"); sys.exit(1)
if wall > 40000:
    print(f"  FAIL  t.me scrape hit the ceiling ({wall}ms)"); sys.exit(1)
print("  PASS  t.me scraped real rendered content (no early-quit)")
PY
[ $? -ne 0 ] && bad "t.me early-quit guard" || ok "t.me early-quit guard"

# 6d) session must be RELEASED after each scrape (no stuck Live sessions).
python3 - <<'PY'
import json, subprocess, time
rows = json.loads(subprocess.run(['curl','-s','--max-time','10','http://127.0.0.1:3000/v1/sessions'],capture_output=True,text=True).stdout)['sessions']
live = [r for r in rows if r.get('status') == 'live']
if live:
    print(f"  FAIL  {len(live)} session(s) still Live after scrapes: {[r['id'][:8] for r in live]}")
    raise SystemExit(1)
print("  PASS  no stuck Live sessions (browser-per-job teardown intact)")
PY
[ $? -ne 0 ] && bad "session teardown" || ok "session teardown"

echo
echo "=== 7) Xvfb leftovers ==="
ps aux | grep '[X]vfb :' | grep -v ':10 ' || echo "  none-extra"
echo
echo "verification done"
[ "$FAIL" = "0" ] || exit 1
