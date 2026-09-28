# Steel Browser (self-hosted, single VM)

Patched-down Steel Browser monorepo (`api` + `ui` + `repl`) running headful on
Xvfb with automatic extension loading and automatic video recording of every
scrape/session.

## Browser engine: CloakBrowser (stealth Chromium)

Launches prefer the [CloakBrowser](https://github.com/CloakHQ/cloakbrowser)
stealth Chromium — a Chromium build with fingerprint patches compiled into the
binary at the C++ source level (canvas, WebGL, audio, fonts, GPU, WebRTC,
automation-signal removal) — and fall back to stock Google Chrome when it is
not installed.

Detection order (mirrored in `api/src/utils/resolve-browser.ts` and
`setup.sh`):

1. `CLOAKBROWSER_BINARY_PATH` (or `CLOAKBROWSER_EXECUTABLE_PATH`) — explicit override
2. `~/.cloakbrowser/chromium-<version>/chrome` — the binary `npx cloakbrowser install`
   downloads (highest version wins; `-pro` builds preferred when a license key exists)
3. `CHROME_EXECUTABLE_PATH`
4. `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`,
   `/usr/bin/chromium-browser`
5. Patchright's bundled Chromium

When the CloakBrowser binary is selected, the launcher passes the same stealth
arguments the official wrapper passes on Linux — `--fingerprint=<random seed>`
and `--fingerprint-platform=windows` — which drive the patched code paths
inside the binary. The active engine is reported by `GET /v1/health` as
`{"status":"ok","browser":"cloakbrowser"|"chrome"}` and logged on startup.

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
| `STEEL_DISABLE_CLOAKBROWSER=true` | Ignore CloakBrowser, use stock Chrome |

Verify which engine is live:

```bash
curl -s http://127.0.0.1:3000/v1/health
# {"status":"ok","browser":"cloakbrowser"}
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
