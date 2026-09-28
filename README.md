# Steel Browser (self-hosted, single VM)

Patched-down Steel Browser monorepo (`api` + `ui` + `repl`) running headful on
Xvfb with automatic extension loading and automatic video recording of every
scrape/session.

## Browser engine: CloakBrowser only (no stock Chrome)

This deployment launches exclusively the
[CloakBrowser](https://github.com/CloakHQ/cloakbrowser) stealth Chromium — a
Chromium build with fingerprint patches compiled into the binary at the C++
source level (canvas, WebGL, audio, fonts, GPU, WebRTC, automation-signal
removal). Stock Chrome/Chromium is not supported: there is no fallback, and
`setup.sh` refuses to start without the CloakBrowser binary.

Binary resolution (mirrored in `api/src/utils/resolve-browser.ts` and
`setup.sh`):

1. `CLOAKBROWSER_BINARY_PATH` (or `CLOAKBROWSER_EXECUTABLE_PATH`) — explicit override
2. `~/.cloakbrowser/chromium-<version>/chrome` — what `npx cloakbrowser install`
   downloads (highest version wins; `-pro` builds preferred when licensed)

If neither exists, launches fail with `CloakBrowser binary not found. Install
it with: npx cloakbrowser install`.

The launcher passes the stealth arguments that drive the patched code paths —
`--fingerprint=<random seed>` and `--fingerprint-platform=linux` (native Linux
persona; the binary spoofs GPU/hardware/screen from the seed). The engine is
reported by `GET /v1/health` as `{"status":"ok","browser":"cloakbrowser",
"browserRunning":false}` (`browserRunning` is true while a session is live).

### Installing CloakBrowser (on the VM)

```bash
npx cloakbrowser install      # downloads the stealth Chromium (~200MB) to ~/.cloakbrowser
./setup.sh restart            # picks it up automatically; check ./setup.sh status
```

Optional env vars:

| Variable | Effect |
| --- | --- |
| `CLOAKBROWSER_BINARY_PATH` | Use exactly this binary |
| `CLOAKBROWSER_CACHE_DIR` | Custom cache dir to scan (default `~/.cloakbrowser`) |

Verify:

```bash
curl -s http://127.0.0.1:3000/v1/health
# {"status":"ok","browser":"cloakbrowser","browserRunning":false}
```

## Setup / operations

```bash
./setup.sh              # install deps, build api+ui, start
./setup.sh restart      # restart after a git pull
./setup.sh status       # process, health, extensions, UI
./setup.sh test         # smoke test: health + scrape example.com
```

The API serves the UI at `http://<host>:3000/ui` (sessions dashboard with
per-session video review). Recordings land in `/data/recordings/<sessionId>.mp4`.

Requirements: Node >= 22, Chrome or the CloakBrowser binary, Xvfb on `:10`
(`DISPLAY=:10`) for headful launches. As root, `--no-sandbox` is added
automatically.
