#!/usr/bin/env bash
# ACL + end-to-end verification for the /xreactor endpoint.
#
# Run ON the VM from the repo root:  bash scripts/xreactor-acl-test.sh [test-url]
#
# Verifies the full isolation matrix without ever printing the edge token:
#   1. Direct IP  -> /xreactor                    => 403 (endpoint is domain-only)
#   2. Spoofed Host via IP, no token              => 403 (edge token enforced)
#   3. Spoofed Host via IP, with token            => 200 (that IS the Caddy path)
#   4. Domain -> /v1/health                       => 302 to /xreactor
#   5. Domain -> /ui/                             => 302 to /xreactor
#   6. Domain -> /xreactor (no url)               => 200 usage page
#   7. Domain -> /xreactor?url=...                => 200 the real check (e2e)
#   8. Plain HTTP -> https redirect               => 308
#   9. Sibling Caddy site still works             => any 2xx/3xx
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/api/.env"
PORT="${PORT:-3000}"
DOMAIN="${XREACTOR_ALLOWED_HOST:-xreactor-bot.duckdns.org}"
TEST_URL="${1:-https://example.com}"
TOKEN=""

if [[ -f "${ENV_FILE}" ]]; then
  TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
loc() { curl -s -o /dev/null -w "%{redirect_url}" "$@"; }

pass=0; fail=0
check() {
  local name="$1" expected="$2" got="$3"
  if [[ "${got}" == "${expected}" ]]; then
    echo "  PASS  ${name}: ${got}"
    pass=$((pass + 1))
  else
    echo "  FAIL  ${name}: expected ${expected}, got ${got}"
    fail=$((fail + 1))
  fi
}

echo "=== XReactor ACL matrix (test url: ${TEST_URL}) ==="

echo "1) Direct IP -> /xreactor (expect 403)"
c=$(code -X POST "http://127.0.0.1:${PORT}/xreactor" -H "Content-Type: application/json" -d "{\"url\":\"${TEST_URL}\"}" --max-time 20)
check "ip-direct" 403 "${c}"

echo "2) Spoofed Host via IP, no edge header (expect 403)"
c=$(code -X POST "http://127.0.0.1:${PORT}/xreactor" -H "Host: ${DOMAIN}" -H "Content-Type: application/json" -d "{\"url\":\"${TEST_URL}\"}" --max-time 20)
check "spoof-host-no-token" 403 "${c}"

echo "3) Spoofed Host via IP WITH edge header (expect 200 — this is the Caddy path)"
if [[ -n "${TOKEN}" ]]; then
  c=$(code -X POST "http://127.0.0.1:${PORT}/xreactor" -H "Host: ${DOMAIN}" -H "X-Xreactor-Edge: ${TOKEN}" -H "Content-Type: application/json" -d "{\"url\":\"${TEST_URL}\"}" --max-time 300)
  check "spoof-host-with-token" 200 "${c}"
else
  echo "  SKIP  no token configured"
fi

echo "4) Domain -> /v1/health (expect 302 -> /xreactor)"
c=$(code "https://${DOMAIN}/v1/health" --max-time 15)
l=$(loc "https://${DOMAIN}/v1/health" --max-time 15)
check "domain-health" 302 "${c}"
if [[ "${l}" == *"/xreactor"* ]]; then
  echo "  PASS  domain-health location: ${l}"
else
  echo "  FAIL  domain-health location: ${l}"
  fail=$((fail + 1))
fi

echo "5) Domain -> /ui/ (expect 302 -> /xreactor)"
c=$(code "https://${DOMAIN}/ui/" --max-time 15)
check "domain-ui" 302 "${c}"

echo "6) Domain -> /xreactor without url (expect 200 usage page)"
c=$(code "https://${DOMAIN}/xreactor" --max-time 15)
check "domain-xreactor-usage" 200 "${c}"

echo "7) Domain -> /xreactor?url=... (expect 200 — the real end-to-end path)"
c=$(code "https://${DOMAIN}/xreactor?url=${TEST_URL}" --max-time 300)
check "domain-xreactor" 200 "${c}"

echo "8) Plain HTTP -> HTTPS redirect (expect 308)"
c=$(code "http://${DOMAIN}/xreactor" --max-time 15)
check "http-redirect" 308 "${c}"

echo "9) Sibling Caddy site (bin-atlas) still healthy"
c=$(code "http://bin-atlas.duckdns.org/" --max-time 15)
if [[ "${c}" =~ ^[23] ]]; then
  check "sibling-site" "${c}" "${c}"
else
  check "sibling-site" "2xx/3xx" "${c}"
fi

echo
echo "Results: ${pass} passed, ${fail} failed"
exit "${fail}"
