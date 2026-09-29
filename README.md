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

## XReactor endpoint (`/xreactor`)

A dedicated compliance endpoint that answers only via the
`xreactor-bot.duckdns.org` hostname (plain HTTP through Caddy). It takes just
a `url`, scrapes it to markdown (using the same CloakBrowser session flow as
`/v1/scrape`, including challenge handling), and reports whether any spelling
or variant of "cloud" appears:

- Plain `cloud` and word stems (`clouds`, `cloudy`, `cloudflare`, ...)
- Leetspeak/homoglyphs: `cl0ud`, `c1oud`, `kl0ud`, `c|oud`, cyrillic/greek o
- Spaced/split: `c loud`, `c-l-o-u-d`, `cl.oud`
- Related spellings: `kloud`, `cload`

It also follows up to **3 additional pages** linked from the seed (ads,
trackers, social widgets, binaries and non-http schemes are filtered out;
`nofollow`/`sponsored` links are treated as ads). The first cloud hit ends the
crawl early. Opening the domain root in a browser redirects to `/xreactor`,
which shows a small usage page when no `url` parameter is given.

```bash
# POST
curl -X POST https://xreactor-bot.duckdns.org/xreactor \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'

# GET
curl 'https://xreactor-bot.duckdns.org/xreactor?url=https://example.com'
```

Response:

```json
{
  "result": "allowed" | "disallowed",
  "seedUrl": "...",
  "pages": [{ "url": "...", "status": "ok", "cloudFound": false, "matches": [], "followedFrom": null }],
  "links": { "found": 6, "followed": ["..."], "skippedAds": 2, "skippedBinary": 0, "skippedOther": 1 },
  "timings": { "totalMs": 41234 }
}
```

### Domain isolation

The isolation is enforced inside the API itself (`api/src/modules/xreactor/xreactor.acl.ts`):

- `/xreactor` only answers requests whose Host header is
  `xreactor-bot.duckdns.org` (override with `XREACTOR_ALLOWED_HOST`).
- A global hook sends every OTHER path under that Host to `/xreactor` —
  the domain always lands on the endpoint, no matter what route the visitor
  types. The IP:3000 address cannot reach `/xreactor` at all.
- Shared-secret: `XREACTOR_EDGE_TOKEN` in `api/.env` is injected by Caddy
  (`header_up X-Xreactor-Edge <token>`); this blocks Host-header spoofing
  straight against the IP. `scripts/xreactor-edge.sh` (run on the VM) wires
  the token and the Caddy site block automatically.

Caddy site block (in `/etc/caddy/Caddyfile`, managed by the script):

```caddy
xreactor-bot.duckdns.org {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Xreactor-Edge <token>
    }
}
```

The bare hostname gives automatic HTTPS (Let's Encrypt cert, same as the
other duckdns sites on the VM) plus an automatic HTTP→HTTPS redirect on
port 80.

Important: pages that fail to load (network error, challenge that never
clears) are reported with `"status": "error"` per page and the verdict stays
`allowed` (no cloud detected on an unverified page is not a violation) —
check the per-page status when acting on the result.

Requirements: Node >= 22, Chrome or the CloakBrowser binary, Xvfb on `:10`
(`DISPLAY=:10`) for headful launches. As root, `--no-sandbox` is added
automatically.
