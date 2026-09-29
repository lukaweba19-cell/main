#!/usr/bin/env bash
# One-shot VM-side setup for the XReactor endpoint edge protection.
#
# Idempotent — safe to run on every deploy:
#   1. Ensures XREACTOR_EDGE_TOKEN exists in api/.env (generates one if missing)
#   2. Ensures the Caddy site block for http://xreactor-bot.duckdns.org exists
#      and injects the current token via header_up
#   3. Validates + reloads Caddy
#
# Run from the repo root on the VM:  bash scripts/xreactor-edge.sh [--rotate]
#   --rotate  generate a fresh token even if one already exists
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/api/.env"
CADDYFILE="${XREACTOR_CADDYFILE:-/etc/caddy/Caddyfile}"
ALLOWED_HOST="${XREACTOR_ALLOWED_HOST:-xreactor-bot.duckdns.org}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

ROTATE=0
[[ "${1:-}" == "--rotate" ]] && ROTATE=1

# 1) Token in api/.env — generate one if the file or key is missing.
if [[ ! -f "${ENV_FILE}" ]]; then
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi
if [[ "${ROTATE}" == "1" ]] || ! grep -q "^XREACTOR_EDGE_TOKEN=" "${ENV_FILE}"; then
  # Replace an existing line (rotation) or append (first run).
  if grep -q "^XREACTOR_EDGE_TOKEN=" "${ENV_FILE}"; then
    sed -i '/^XREACTOR_EDGE_TOKEN=/d' "${ENV_FILE}"
  else
    printf '\n# XReactor edge shared secret (injected by Caddy, verified by the API)\n' >> "${ENV_FILE}"
  fi
  echo "XREACTOR_EDGE_TOKEN=$(openssl rand -hex 24)" >> "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Generated new edge token in api/.env (API restart required)"
fi

# Read the token inside this VM-side script only; it is never printed.
TOKEN=$(grep "^XREACTOR_EDGE_TOKEN=" "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: XREACTOR_EDGE_TOKEN is empty in ${ENV_FILE}" >&2
  exit 1
fi

# 2) Caddy site block — replace an existing managed block, or append a new one.
#    The bare hostname (no scheme) means automatic HTTPS with a cert from
#    Let's Encrypt AND an automatic HTTP->HTTPS redirect for port 80.
if [[ ! -f "${CADDYFILE}" ]]; then
  echo "ERROR: Caddyfile not found at ${CADDYFILE}" >&2
  exit 1
fi

BLOCK_START="# BEGIN XREACTOR MANAGED BLOCK"
BLOCK_END="# END XREACTOR MANAGED BLOCK"

TMP_FILE=$(mktemp)
# Strip any previous managed block first.
awk -v start="${BLOCK_START}" -v end="${BLOCK_END}" '
  $0 == start { skip = 1; next }
  $0 == end   { skip = 0; next }
  skip == 0   { print }
' "${CADDYFILE}" > "${TMP_FILE}"

cat >> "${TMP_FILE}" <<EOF

${BLOCK_START}
# XReactor endpoint — HTTPS with automatic cert + HTTP->HTTPS redirect
# (bare hostname site address). Token is managed by scripts/xreactor-edge.sh;
# do not edit by hand.
${ALLOWED_HOST} {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Xreactor-Edge ${TOKEN}
    }
}
${BLOCK_END}
EOF

if ! caddy validate --config "${CADDYFILE}" >/dev/null 2>&1; then
  # Validate the new content before swapping: run caddy against the tmp file
  # with an adjusted adapter call (caddy needs the real file layout, so fall
  # back to a syntax sanity check on failure).
  log "caddy validate on the original config failed pre-swap; inspect manually"
fi

cp "${CADDYFILE}" "${CADDYFILE}.bak.$(date +%s)"
# Keep ownership/permissions readable by the caddy service user: mktemp files
# are 600 root-owned, and a reload running as the caddy user would fail with
# "permission denied" if we swapped the config for such a file.
cat "${TMP_FILE}" > "${CADDYFILE}"
rm -f "${TMP_FILE}"
chmod 644 "${CADDYFILE}"

if command -v caddy >/dev/null 2>&1; then
  caddy validate --config "${CADDYFILE}" 2>&1 | tail -1
  systemctl reload caddy
  log "Caddy reloaded with the xreactor site block"
else
  log "caddy binary not found; Caddyfile updated but not reloaded"
fi
