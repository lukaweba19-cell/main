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

# CloakBrowser-only: resolve the stealth Chromium, or fail with instructions.
# Stock Chrome/Chromium is not supported in this deployment.
CLOAK_BINARY=""
if [[ -n "${CLOAKBROWSER_BINARY_PATH:-}" && -x "${CLOAKBROWSER_BINARY_PATH}" ]]; then
  CLOAK_BINARY="${CLOAKBROWSER_BINARY_PATH}"
elif [[ -d "${HOME}/.cloakbrowser" ]]; then
  CLOAK_BINARY=$(ls -1 "${HOME}"/.cloakbrowser/chromium-*/chrome 2>/dev/null | sort -r | head -1 || true)
fi
if [[ -z "${CLOAK_BINARY}" ]]; then
  err "CloakBrowser binary not found (~/.cloakbrowser). Install with: npx cloakbrowser install"
  exit 1
fi
CHROME_EXECUTABLE_PATH="${CHROME_EXECUTABLE_PATH:-${CLOAK_BINARY}}"

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

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

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
  # Clear stale Chrome processes and profile lock from previous crashes
  pkill -f '/tmp/steel-chrome' 2>/dev/null || true
  pkill -f 'google-chrome.*steel-chrome' 2>/dev/null || true
  sleep 1
  rm -rf /tmp/steel-chrome 2>/dev/null || true
  mkdir -p /data/extensions /data/profiles /files /tmp/.steel
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
