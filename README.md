# Steel Browser (self-hosted, single VM)

Patched-down Steel Browser monorepo (`api` + `ui` + `repl`) running headful on
Xvfb with automatic extension loading and automatic video recording of every
scrape/session.

## Browser engine: nodriver + stock Chrome

CloakBrowser is GONE. Browsers are launched by [nodriver](https://github.com/ultrafunkamsterdam/nodriver)
(the undetected-chromedriver successor) via a small Python sidecar
(`api/python/nodriver_launcher.py`), and the Node API attaches to the resulting
CDP endpoint with patchright's `connectOverCDP`. All Steel machinery — sessions,
extensions, recordings, page-events, the xreactor pipeline — is unchanged; only
the process launcher differs.

- `setup.sh` installs Google Chrome stable automatically if no Chrome/Chromium
  is present (`CHROME_EXECUTABLE_PATH` overrides).
- The Python sidecar runs from `api/python/.venv` (deps in
  `api/python/requirements.txt`, plus the optional
  [nodriver-cf-verify](https://github.com/omegastrux/nodriver-cf-verify)
  Turnstile auto-clicker).
- The engine is reported by `GET /v1/health` as `{"status":"ok","browser":"chrome",
  "browserRunning":false}` (`browserRunning` is true while a session is live).

### Persistent fingerprint (one identity, every launch)

There are no per-launch fingerprint seeds anywhere. The fingerprint IS the
profile: a durable default profile at `/data/steel-profiles/default` holds the
fonts, prefs, cookies, language and window metrics, and EVERY browser launch
reuses it:

- sessions & scrapes run on the default profile directly (or `persist: true`),
- every xreactor check runs on a fresh CLONE of it (temp dir, deleted after),
- sessions & scrapes can select an uploaded profile with `profileId`
  (empty/omitted = default); xreactor checks ALWAYS use the default.

Because the same profile directory is reused, any preference the user saves
("Always allow", fonts, logins) persists across launches and restarts.

### The "Open xdg-open?" popup: fixed for real

The old attempts failed because they seeded `protocol_handler.excluded_schemes`
into `Secure Preferences` — keys modern Chromium removed, and Secure Preferences
is HMAC-tracked so Chromium silently resets foreign values. The dialog decision
now lives in `external_protocol_handler.cc` →
`protocol_handler.allowed_origin_protocol_pairs` + the
`AutoLaunchProtocolsFromOrigins` enterprise policy. Three layers cover it:

1. **Enterprise policy** (`/etc/opt/chrome/policies/managed/steel-external-protocols.json`,
   installed by `setup.sh`): auto-allows the external schemes from any origin —
   checked BEFORE the dialog can ever be created.
2. **Profile prefs** (`api/src/utils/default-profile.ts`): the modern
   `allowed_origin_protocol_pairs` map is seeded into the durable default
   profile (and re-asserted on every clone) — the same pref the "Always allow"
   checkbox writes.
3. **xdg-open shim** (`/usr/local/bin/xdg-open`, installed by `setup.sh`):
   even if a launch slips through, `xdg-open` exits 0 instantly — nothing can
   stall the page.

## Setup / operations

```bash
./setup.sh              # install deps, build api+ui, start
./setup.sh restart      # restart after a git pull
./setup.sh status       # process, health, extensions, UI
./setup.sh test         # smoke test: health + scrape example.com
```

## XReactor endpoint (`/xreactor`)

A dedicated compliance endpoint that answers only via the
`xreactor-bot.duckdns.org` hostname (HTTPS through Caddy). It takes a `url`
(string or array) and scrapes each page to markdown in its **own isolated
CloakBrowser** — never the shared Steel session browser — then reports
whether any spelling or variant of "cloud" appears:

- Plain `cloud` and word stems (`clouds`, `cloudy`, `cloudflare`, ...)
- Leetspeak/homoglyphs: `cl0ud`, `c1oud`, `kl0ud`, `c|oud`, cyrillic/greek o
- Spaced/split: `c loud`, `c-l-o-u-d`, `cl.oud`
- Related spellings: `kloud`, `cload`

It also follows up to **3 additional pages** linked from each seed (ads,
trackers, social widgets, binaries and non-http schemes are filtered out;
`nofollow`/`sponsored` links are treated as ads). The first cloud hit ends the
crawl early. Opening the domain root in a browser redirects to `/xreactor`,
which serves a Scalar OpenAPI reference scoped to this endpoint.

There are no optional tuning fields: every check runs on the durable default
profile (the single persistent fingerprint, with the seeded external-protocol
prefs) and always runs nodriver-cf-verify on Cloudflare Turnstile pages.
Neither is client-configurable — legacy `profileId`/`cfVerify` body fields are
ignored.

### Isolation & scale

- Every checked URL runs in its own nodriver-launched Chrome with a fresh
  CLONE of the durable default profile (persistent fingerprint, closed and
  deleted afterwards) — no shared state, no cross-check pollution. The profile
  is not selectable: the default profile is the identity for every check.
- Batch requests (`url` as array or `urls: [...]`, cap 25/request) check all
  URLs **in parallel**, each in its own browser, bounded by
  `XREACTOR_MAX_CONCURRENT` (default 4) to protect VM memory.
- Readiness uses a lightweight text-presence check (~1-2s on normal pages);
  only real challenge interstitials get a longer (30s) wait budget.
- A daily-flush janitor (hourly pass) deletes recordings and session history
  older than 24h and sweeps stale profile dirs — see
  `api/src/utils/janitor.ts` (`RECORDINGS_MAX_AGE_HOURS`,
  `SESSION_HISTORY_MAX_AGE_HOURS`).

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

Requirements: Node >= 22, Python 3 + `api/python/.venv` (nodriver sidecar,
installed by `./setup.sh`), Chrome/Chromium (auto-installed by `./setup.sh`),
Xvfb on `:10` (`DISPLAY=:10`) for headful launches. As root, `--no-sandbox` is
added automatically.
