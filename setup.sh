#!/usr/bin/env bash
set -euo pipefail

# Steel Browser - setup & start script
# Usage:
#   ./setup.sh              # install, build, start
#   ./setup.sh start        # start only (assumes already built)
#   ./setup.sh stop         # stop running server
#   ./setup.sh restart      # stop + start
#   ./setup.sh status       # health + process status
#   ./setup.sh test         # smoke test (health + scrape markdown)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${ROOT_DIR}/api"
PID_FILE="${ROOT_DIR}/.steel.pid"
LOG_FILE="${ROOT_DIR}/steel-api.log"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
NODE_ENV="${NODE_ENV:-production}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

# nodriver stack: resolve the Chrome/Chromium binary the Python sidecar will
# launch, installing Google Chrome if nothing is present.
CHROME_EXECUTABLE_PATH="${CHROME_EXECUTABLE_PATH:-}"
if [[ -z "${CHROME_EXECUTABLE_PATH}" ]]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      CHROME_EXECUTABLE_PATH="$(command -v "${candidate}")"
      break
    fi
  done
fi
if [[ -z "${CHROME_EXECUTABLE_PATH}" ]] || [[ ! -x "${CHROME_EXECUTABLE_PATH}" ]]; then
  log "No Chrome/Chromium found — installing Google Chrome stable..."
  if command -v apt-get >/dev/null 2>&1; then
    wget -qO /tmp/google-chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
      || err "Chrome download failed"
    apt-get install -y /tmp/google-chrome.deb >/dev/null || apt-get -f install -y >/dev/null
    rm -f /tmp/google-chrome.deb
    CHROME_EXECUTABLE_PATH="$(command -v google-chrome || echo /usr/bin/google-chrome)"
  else
    err "No Chrome found and apt-get unavailable. Set CHROME_EXECUTABLE_PATH."
    exit 1
  fi
fi

# --- External-protocol popup kill (the "Open xdg-open?" dialog) ------------
# Two OS-level backstops so NO chromium build can ever show the dialog:
#   1. Enterprise policy AutoLaunchProtocolsFromOrigins (machine JSON; read by
#      external_protocol_handler BEFORE the dialog) auto-allows the schemes
#      from any web origin.
#   2. An xdg-open shim: if a launch still slips through, xdg-open exits 0
#      instantly instead of opening/stalling a real handler.
install_popup_backstops() {
  local policy_dir="/etc/opt/chrome/policies/managed"
  mkdir -p "${policy_dir}"
  cat > "${policy_dir}/steel-external-protocols.json" <<'POLICY'
{
  "AutoLaunchProtocolsFromOrigins": [
    { "protocol": "tg", "allowed_origins": ["*"] },
    { "protocol": "whatsapp", "allowed_origins": ["*"] },
    { "protocol": "viber", "allowed_origins": ["*"] },
    { "protocol": "skype", "allowed_origins": ["*"] },
    { "protocol": "slack", "allowed_origins": ["*"] },
    { "protocol": "zoommtg", "allowed_origins": ["*"] },
    { "protocol": "discord", "allowed_origins": ["*"] },
    { "protocol": "webcal", "allowed_origins": ["*"] },
    { "protocol": "steam", "allowed_origins": ["*"] },
    { "protocol": "spotify", "allowed_origins": ["*"] },
    { "protocol": "mailto", "allowed_origins": ["*"] },
    { "protocol": "tel", "allowed_origins": ["*"] },
    { "protocol": "sms", "allowed_origins": ["*"] }
  ]
}
POLICY

  if [[ ! -e /usr/local/bin/xdg-open ]]; then
    mv /usr/bin/xdg-open /usr/bin/xdg-open.real 2>/dev/null || true
    cat > /usr/local/bin/xdg-open <<'SHIM'
#!/bin/sh
# Steel VM shim: swallow external protocol launches (no-op, exit 0).
exit 0
SHIM
    chmod +x /usr/local/bin/xdg-open
  fi
}
install_popup_backstops

# --- nodriver Python sidecar -------------------------------------------------
ensure_python_sidecar() {
  command -v python3 >/dev/null || { err "python3 not found (required for nodriver)"; exit 1; }
  log "Ensuring nodriver Python sidecar venv..."
  if [[ ! -x "${API_DIR}/python/.venv/bin/python" ]]; then
    python3 -m venv "${API_DIR}/python/.venv"
  fi
  "${API_DIR}/python/.venv/bin/pip" install -q --upgrade pip
  "${API_DIR}/python/.venv/bin/pip" install -q -r "${API_DIR}/python/requirements.txt"
  # Optional Turnstile auto-verify (DOM-based, no OpenCV).
  "${API_DIR}/python/.venv/bin/pip" install -q "git+https://github.com/omegastrux/nodriver-cf-verify.git" \
    || log "  nodriver-cf-verify unavailable (optional)"
  # Python 3.14 rejects undeclared non-UTF-8 bytes; nodriver ships a latin-1
  # "±" in a cdp comment (network.py "JSON (±Inf)"). Patch it to ASCII.
  local netfile
  for netfile in "${API_DIR}"/python/.venv/lib/python3.*/site-packages/nodriver/cdp/network.py; do
    [[ -f "${netfile}" ]] || continue
    if LC_ALL=C grep -q $'\xc2\xb1' "${netfile}" 2>/dev/null; then
      python3 -c "
import sys
p = sys.argv[1]
d = open(p, 'rb').read()
open(p, 'wb').write(d.replace(b'JSON (\\xc2\\xb1Inf)', b'JSON (+/-Inf)'))
print('patched non-UTF-8 byte in', p)
" "${netfile}"
    fi
  done
  log "  python sidecar ready: ${API_DIR}/python/.venv/bin/python"
}
ensure_python_sidecar

UI_DIST_PATH="${UI_DIST_PATH:-${ROOT_DIR}/ui/dist}"
DOMAIN="${DOMAIN:-207.180.29.28:3000}"
# XReactor endpoint isolation (see api/src/modules/xreactor/xreactor.acl.ts)
XREACTOR_ALLOWED_HOST="${XREACTOR_ALLOWED_HOST:-xreactor-bot.duckdns.org}"
export HOST PORT NODE_ENV CHROME_EXECUTABLE_PATH UI_DIST_PATH DOMAIN \
  XREACTOR_ALLOWED_HOST
# Edge token is NOT exported when unset: an empty value would shadow the
# XREACTOR_EDGE_TOKEN the API loads from api/.env via dotenv.
if [[ -n "${XREACTOR_EDGE_TOKEN:-}" ]]; then
  export XREACTOR_EDGE_TOKEN
fi
# Browser is always headful on the Xvfb display.
export DISPLAY="${DISPLAY:-:10}"
export NODRIVER_SIDECAR_PORT="${NODRIVER_SIDECAR_PORT:-9224}"
export NODRIVER_PYTHON="${API_DIR}/python/.venv/bin/python"

check_deps() {
  log "Checking dependencies..."
  command -v node >/dev/null || { err "node not found"; exit 1; }
  command -v npm >/dev/null || { err "npm not found"; exit 1; }
  local node_ver
  node_ver=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [[ "${node_ver}" -lt 22 ]]; then
    err "Node.js >= 22 required (found $(node -v))"
    exit 1
  fi
  log "  node $(node -v) / npm $(npm -v)"

  if [[ -z "${CHROME_EXECUTABLE_PATH}" ]] || [[ ! -x "${CHROME_EXECUTABLE_PATH}" ]]; then
    err "Chrome/Chromium not found. Set CHROME_EXECUTABLE_PATH."
    exit 1
  fi
  log "  chrome: ${CHROME_EXECUTABLE_PATH} ($("${CHROME_EXECUTABLE_PATH}" --version 2>/dev/null || echo unknown))"
  if [[ ! -x "${API_DIR}/python/.venv/bin/python" ]]; then
    err "nodriver python venv missing — run ./setup.sh (full setup) first"
    exit 1
  fi
  log "  nodriver sidecar python: ${API_DIR}/python/.venv/bin/python"
}

install_deps() {
  log "Installing npm dependencies..."
  cd "${ROOT_DIR}"
  # Dev dependencies are required for the TypeScript build; NODE_ENV=production
  # would make npm skip them, so always install with --include=dev.
  if [[ -f package-lock.json ]]; then
    npm ci --include=dev --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --include=dev --prefer-offline --no-audit --no-fund
  else
    npm install --include=dev --prefer-offline --no-audit --no-fund
  fi
  log "Dependencies installed."
}

build() {
  log "Building API and UI..."
  cd "${ROOT_DIR}"
  npm run build -w api
  if [[ ! -f "${API_DIR}/build/index.js" ]]; then
    err "Build failed: ${API_DIR}/build/index.js missing"
    exit 1
  fi
  VITE_API_URL= VITE_WS_URL= npm run build -w ui
  if [[ ! -f "${ROOT_DIR}/ui/dist/index.html" ]]; then
    err "UI build failed: ui/dist/index.html missing"
    exit 1
  fi
  log "Build complete (API + UI)."
}

ensure_dirs() {
  # Clear stale chrome processes and profile locks from previous crashes.
  pkill -f 'remote-debugging-port' 2>/dev/null || true
  # Stop any sidecar from a previous API run so it can't serve stale code.
  pkill -f 'nodriver_launcher.py' 2>/dev/null || true
  # Kill orphaned ffmpeg screen recorders from previous runs — a leaked one
  # burns a full CPU core encoding an idle screen (the VM is 3 cores).
  pkill -f 'ffmpeg.*x11grab' 2>/dev/null || true
  # Free any Xvfb display numbers the allocator uses (:11+) left over from a
  # crashed run — stale locks would make the display allocator skip numbers
  # until it exhausted its range. The shared production display :10 stays up.
  for pid in \
    $(pgrep -f 'Xvfb :1[1-9]' 2>/dev/null) \
    $(pgrep -f 'Xvfb :[2-9][0-9]' 2>/dev/null); do
    kill -9 "${pid}" 2>/dev/null || true
  done
  for n in $(seq 11 39); do
    rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}" 2>/dev/null || true
  done
  sleep 1
  rm -f /tmp/steel-chrome/Singleton* 2>/dev/null || true
  rm -rf /tmp/xreactor-profile-* /tmp/xreactor-uploaded-* 2>/dev/null || true
  mkdir -p /data/extensions /data/profiles /data/steel-profiles /files /tmp/.steel
  mkdir -p "${ROOT_DIR}"
}

is_running() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid=$(cat "${PID_FILE}")
    if kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  # fallback: look for our process
  pgrep -f "node build/index.js" >/dev/null 2>&1 && return 0
  return 1
}

stop_server() {
  log "Stopping Steel Browser API..."
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid=$(cat "${PID_FILE}")
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "${pid}" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" 2>/dev/null || true
      fi
    fi
    rm -f "${PID_FILE}"
  fi
  # clean any leftover
  pkill -f "node build/index.js" 2>/dev/null || true
  # free port if something else holds it
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
  fi
  log "Stopped."
}

start_server() {
  if is_running; then
    log "Server already running (PID $(cat "${PID_FILE}" 2>/dev/null || pgrep -f 'node build/index.js'))."
    return 0
  fi

  ensure_dirs
  if [[ ! -f "${API_DIR}/build/index.js" ]]; then
    err "API not built. Run: ./setup.sh (full setup) or ./setup.sh build"
    exit 1
  fi

  log "Starting Steel Browser API on ${HOST}:${PORT}..."
  log "  CHROME_EXECUTABLE_PATH=${CHROME_EXECUTABLE_PATH}"
  log "  NODE_ENV=${NODE_ENV}"
  log "  log file: ${LOG_FILE}"

  cd "${API_DIR}"
  nohup env \
    NODE_ENV="${NODE_ENV}" \
    HOST="${HOST}" \
    PORT="${PORT}" \
    CHROME_EXECUTABLE_PATH="${CHROME_EXECUTABLE_PATH}" \
    NODRIVER_SIDECAR_PORT="${NODRIVER_SIDECAR_PORT}" \
    NODRIVER_PYTHON="${NODRIVER_PYTHON}" \
    DISPLAY="${DISPLAY}" \
    UI_DIST_PATH="${UI_DIST_PATH}" \
    DOMAIN="${DOMAIN}" \
    XREACTOR_ALLOWED_HOST="${XREACTOR_ALLOWED_HOST}" \
    ${XREACTOR_EDGE_TOKEN:+XREACTOR_EDGE_TOKEN="${XREACTOR_EDGE_TOKEN}"} \
    node build/index.js >> "${LOG_FILE}" 2>&1 &
  local pid=$!
  echo "${pid}" > "${PID_FILE}"
  log "Started PID ${pid}"

  # wait for the HTTP server to come up.
  # NOTE: /v1/health returns 503 while the browser is not yet launched — the
  # browser starts on demand with the first session/scrape, so 503 is a valid
  # idle state. Wait for the HTTP server itself to respond (any status).
  local max=30
  local i=1
  while [[ $i -le $max ]]; do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/v1/health"; then
      log "HTTP server is up (attempt $i)"
      curl -s "http://127.0.0.1:${PORT}/v1/health" || true
      echo
      return 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      err "Process exited early. Last log lines:"
      tail -30 "${LOG_FILE}" || true
      exit 1
    fi
    sleep 1
    i=$((i + 1))
  done

  err "Server did not become healthy within ${max}s. Logs:"
  tail -40 "${LOG_FILE}" || true
  exit 1
}

status() {
  echo "=== Steel Browser status ==="
  if is_running; then
    echo "Process: running (PID $(cat "${PID_FILE}" 2>/dev/null || pgrep -f 'node build/index.js' | head -1))"
  else
    echo "Process: not running"
  fi
  echo -n "Health: "
  curl -sf --max-time 3 "http://127.0.0.1:${PORT}/v1/health" || echo "unreachable"
  echo
  echo -n "Extensions: "
  curl -sf --max-time 3 "http://127.0.0.1:${PORT}/v1/extensions" || echo "n/a"
  echo
  echo -n "Profiles: "
  curl -sf --max-time 3 "http://127.0.0.1:${PORT}/v1/profiles" || echo "n/a"
  echo
  echo -n "UI /ui: "
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${PORT}/ui/" || echo 000)
  echo "HTTP ${code}"
}

smoke_test() {
  local base="http://127.0.0.1:${PORT}"
  local test_url="${TEST_URL:-https://example.com}"

  log "=== Smoke tests ==="
  log "1) Health"
  curl -sf --max-time 5 "${base}/v1/health" | tee /tmp/steel-health.json
  echo

  log "2) Extensions list"
  curl -sf --max-time 5 "${base}/v1/extensions" | tee /tmp/steel-ext.json
  echo

  log "3) Profiles list"
  curl -sf --max-time 5 "${base}/v1/profiles" | tee /tmp/steel-prof.json
  echo

  log "3b) UI /ui"
  ui_code=$(curl -s -o /tmp/steel-ui.html -w "%{http_code}" --max-time 5 "${base}/ui/" || echo 000)
  echo "UI HTTP ${ui_code}"
  if [[ "${ui_code}" != "200" ]]; then
    err "UI not available at /ui (HTTP ${ui_code})"
    exit 1
  fi
  log "UI /ui: OK"

  log "Waiting briefly for browser readiness..."; sleep 5; log "4) Scrape markdown from ${test_url}"
  # browser may need a few seconds after start
  local resp
  resp=$(curl -sf --max-time 90 -X POST "${base}/v1/scrape" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${test_url}\",\"format\":[\"markdown\"]}" ) || {
      err "Scrape request failed"
      tail -50 "${LOG_FILE}" || true
      exit 1
    }
  echo "${resp}" | tee /tmp/steel-scrape.json | head -c 2000
  echo
  echo "..."

  # basic validation
  if echo "${resp}" | grep -q '"markdown"'; then
    log "Scrape markdown: OK"
  else
    err "Response missing markdown content"
    exit 1
  fi

  log "All smoke tests passed."
}

cmd="${1:-all}"

case "${cmd}" in
  all|setup)
    check_deps
    install_deps
    build
    stop_server || true
    start_server
    status
    ;;
  build)
    check_deps
    build
    ;;
  start)
    check_deps
    start_server
    status
    ;;
  stop)
    stop_server
    ;;
  restart)
    check_deps
    stop_server || true
    start_server
    status
    ;;
  status)
    status
    ;;
  test)
    check_deps
    if ! is_running; then
      start_server
    fi
    smoke_test
    ;;
  *)
    echo "Usage: $0 {setup|start|stop|restart|status|test|build}"
    exit 1
    ;;
esac
