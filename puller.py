#!/usr/bin/env python3
"""Pasteview + Uploadery + pasted.pw keyword scraper using self-hosted Steel Browser.

Talks to the Steel API's `POST /v1/scrape`. Every scrape job gets its own
isolated headful Chrome (own display, own profile clone, own recording) and the
server runs `SCRAPE_MAX_CONCURRENCY` jobs (default 4) truly in parallel —
extra requests queue, they don't fail. The server handles the CF challenge
wait, the Turnstile auto-solve (cfVerify is always on for scrapes), extension
load and the whole browser lifecycle, so this client's only job is to keep
exactly that many scrapes in flight at all times.

Concurrency model (pasted.pw):
  * One `ThreadPoolExecutor` + a single scrape semaphore of `--concurrency`
    slots (default 4 = SCRAPE_MAX_CONCURRENCY). List pages and paste content
    share the same slots, so the server pool is always saturated.
  * A producer window prefetches up to 2x-concurrency `recent.php` list pages
    ahead of the consumers — pagination never waits for content fetches.
  * Paste content jobs (`raw.php`, falling back to `view.php`) fill the
    remaining slots, capped (`concurrency * 6`) so list pages are never
    starved behind a huge content backlog.
  * `raw.php` alone suffices when it yields a solid body AND the list page
    gave us a title — that halves per-paste scrapes. `view.php` is still
    fetched whenever the raw body failed/was challenged or the list title was
    missing (force the old always-fetch behavior with `--always-view`).
  * Retry/backoff inside each task, plus a global cooldown when the API
    answers 429 — a rate limit pauses every worker, not just one.
  * ADAPTIVE concurrency: starts at the full pool size and samples every
    response for CF challenges. When >=50% of the last ~6 scrapes come back
    as challenge pages, the client backs off one slot (down to 1) — challenged
    scrapes burn ~60 s each, so fewer, clean scrapes are FASTER. Once ~8 scrapes
    come back clean it ramps back up to full concurrency. Disable with
    `--no-adaptive`.
  * CF challenges (more common under full concurrency) are retried with
    backoff — list pages re-scrape up to 3 times, paste content is re-queued
    up to 3 times (5 s / 10 s spacing) before being skipped.
  * Items are de-duplicated across pages and failed items are re-queued
    (up to 3 attempts) so no paste is lost to a one-off failure.

pasteview.com / uploadery.com are plain HTTPS API calls (no browser) and run
sequentially, exactly as before.

NOTE: there is no `delay` body field any more (removed: the old `--delay-ms`
flag sent a field the server ignored — content readiness is automatic, with CF
challenge detection and a 45 s budget). `--delay-ms` is gone.

Flags:
  -p / --pasted       scrape pasted.pw
  -pv / --pasteview   scrape pasteview.com API
  -u  / --uploadery   scrape uploadery.com API
  -pg / --page N      starting page for pasted.pw (default 1)
  --max-pages N       stop after N pasted.pw list pages (0 = run to the end)
  -k  / --keyword     keyword (repeatable; default hotmail/outlook/msn/live.com)
  --steel-base URL    Steel API base (default http://127.0.0.1:3000)
  --proxy URL         proxy for Steel browser scrapes (host:port:user:pass ok)
  --concurrency N     max concurrent Steel scrapes (default 4 = server pool;
                      adapts down/up automatically, see --no-adaptive)
  --no-adaptive       pin concurrency at --concurrency, never back off
  --timeout N         per-request HTTP timeout in seconds (default 300)
  --always-view       old behavior: always fetch view.php per paste

Outputs (unchanged):
  hits/<keyword>/<source>_<title>.txt   every paste matching a keyword
  data.db                               sqlite combos table (email:password)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor
from concurrent.futures import wait as futures_wait

# ---------------------------------------------------------------------------
# Steel Browser API
# ---------------------------------------------------------------------------
STEEL_BASE = (os.getenv("STEEL_BASE") or "http://127.0.0.1:3000").rstrip("/")
STEEL_SCRAPE_URL = f"{STEEL_BASE}/v1/scrape"
STEEL_HEALTH_URL = f"{STEEL_BASE}/v1/health"

# Server pool size is SCRAPE_MAX_CONCURRENCY (default 4) — match it so the
# server never has to queue behind us and we never idle its browsers.
STEEL_MAX_CONCURRENCY = max(1, int(os.getenv("STEEL_MAX_CONCURRENCY") or "4"))
STEEL_HTTP_TIMEOUT = max(30, int(os.getenv("STEEL_HTTP_TIMEOUT") or "300"))

DEFAULT_PROXY = os.getenv("STEEL_PROXY") or ""

PASTEVIEW = "https://pasteview.com"
UPLOADERY = "https://uploadery.com"
PASTED = "https://pasted.pw"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

PV_TOKEN = ""
U_COOKIES = ""

KEYWORDS = ["hotmail", "outlook", "msn", "live.com"]
SOURCES = ["pasteview", "uploadery", "pasted"]
PV_MAX_PAGES = 0
PV_SORT = "recent"
U_COLLECTIONS = ["documents"]
U_MAX_PAGES = 0
OUT_DIR = "hits"
DB_PATH = "data.db"

COMBO_RE = re.compile(
    r"(?i)\b([a-z0-9._%+\-]+@([a-z0-9.\-]+\.[a-z]{2,}))\s*[:|;]\s*([^\s:|;]{1,128})"
)

# Transient markers: retryable server/network conditions.
TRANSIENT_MARKERS = (
    "timeout",
    "connection",
    "503",
    "502",
    "502 bad gateway",
    "tunnel",
    "browser not",
    "not initialized",
    "err_tunnel",
    "err_proxy",
    "err_connection",
    "econnreset",
    "temporarily",
)

_scrape_sem: "AdaptiveSlots"  # instantiated after AdaptiveSlots is defined
ALWAYS_VIEW = False
ADAPTIVE = True
MIN_CONCURRENCY = 1

# Adaptive concurrency state: target = configured, effective = what the
# limiter is currently allowing (backed off when CF challenges spike).
_CONC_LOCK = threading.Lock()
_CONC_TARGET = STEEL_MAX_CONCURRENCY
_CONC_EFFECTIVE = STEEL_MAX_CONCURRENCY
_RECENT_OUTCOMES: deque = deque()  # True = challenge/congestion seen

# Global 429 cooldown: a rate limit pauses EVERY worker, not just the one
# that hit it.
RATE_LIMIT_UNTIL = 0.0
_RATE_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# Stats + thread-safe printing
# ---------------------------------------------------------------------------
STATS_LOCK = threading.Lock()
PRINT_LOCK = threading.Lock()
STATS = {
    "scrapes": 0,
    "retries": 0,
    "rate_limited": 0,
    "pages_ok": 0,
    "pages_skipped": 0,
    "items_ok": 0,
    "items_skipped": 0,
    "items_failed": 0,
    "hits": 0,
    "combos": 0,
    "challenges": 0,
}
IN_FLIGHT = 0


class AdaptiveSlots:
    """Resizeable concurrency limiter: acquire() blocks while the effective
    slot count is exhausted; set_max() can shrink/grow it at runtime."""

    def __init__(self, max_slots: int):
        self._cond = threading.Condition()
        self._in = 0
        self._max = max(1, max_slots)

    def acquire(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.time() + timeout
        with self._cond:
            while self._in >= self._max:
                remaining = None if deadline is None else deadline - time.time()
                if remaining is not None and remaining <= 0:
                    return False
                self._cond.wait(remaining)
            self._in += 1
            return True

    def release(self) -> None:
        with self._cond:
            self._in = max(0, self._in - 1)
            self._cond.notify()

    def set_max(self, n: int) -> None:
        with self._cond:
            self._max = max(1, n)
            self._cond.notify_all()


def effective_concurrency() -> int:
    with _CONC_LOCK:
        return _CONC_EFFECTIVE


def note_outcome(congested: bool) -> None:
    """Feed a scrape outcome (True = CF challenge / rate limit) into the
    adaptive concurrency controller."""
    global _CONC_EFFECTIVE
    if not ADAPTIVE:
        return
    with _CONC_LOCK:
        _RECENT_OUTCOMES.append(bool(congested))
        n = len(_RECENT_OUTCOMES)
        if n < 6:
            return
        rate = sum(_RECENT_OUTCOMES) / n
        if rate >= 0.5 and _CONC_EFFECTIVE > MIN_CONCURRENCY:
            _CONC_EFFECTIVE -= 1
            _RECENT_OUTCOMES.clear()
            _scrape_sem.set_max(_CONC_EFFECTIVE)
            p(
                f"[adaptive] challenge rate {rate:.0%} — backing off to "
                f"{_CONC_EFFECTIVE}/{_CONC_TARGET} concurrent scrapes"
            )
        elif n >= 8 and rate == 0 and _CONC_EFFECTIVE < _CONC_TARGET:
            _CONC_EFFECTIVE += 1
            _RECENT_OUTCOMES.clear()
            _scrape_sem.set_max(_CONC_EFFECTIVE)
            p(
                f"[adaptive] clean scrapes — ramping up to "
                f"{_CONC_EFFECTIVE}/{_CONC_TARGET} concurrent scrapes"
            )


_scrape_sem = AdaptiveSlots(STEEL_MAX_CONCURRENCY)


def bump(key: str, n: int = 1) -> None:
    with STATS_LOCK:
        STATS[key] = STATS.get(key, 0) + n


def gauge(delta: int) -> None:
    global IN_FLIGHT
    with STATS_LOCK:
        IN_FLIGHT = max(0, IN_FLIGHT + delta)


def in_flight() -> int:
    with STATS_LOCK:
        return IN_FLIGHT


def p(*args) -> None:
    """Print with a lock so concurrent workers never interleave a line."""
    with PRINT_LOCK:
        print(*args, flush=True)


def set_cooldown(seconds: float) -> None:
    global RATE_LIMIT_UNTIL
    with _RATE_LOCK:
        RATE_LIMIT_UNTIL = max(RATE_LIMIT_UNTIL, time.time() + max(1.0, seconds))


def _wait_rate_limit() -> None:
    while True:
        with _RATE_LOCK:
            until = RATE_LIMIT_UNTIL
        remaining = until - time.time()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 1.0))


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class RateLimitedError(RuntimeError):
    def __init__(self, message: str, retry_after: float = 5.0):
        super().__init__(message)
        self.retry_after = max(1.0, retry_after)


class TransientError(RuntimeError):
    """Network / gateway / browser-lifecycle error — retry with backoff."""


class SteelScrapeError(RuntimeError):
    """Hard API error (bad request etc.) — retrying won't help."""


class PageSkipped(RuntimeError):
    """A pasted.pw list page could not be parsed — skip it and move on."""


class ChallengeRetry(RuntimeError):
    """CF challenge served for a paste — re-queue with backoff, then skip."""


# ---------------------------------------------------------------------------
# Plain HTTPS helper (pasteview / uploadery APIs + Steel health)
# ---------------------------------------------------------------------------
def normalize_proxy(proxy: str) -> str:
    proxy = (proxy or "").strip()
    if not proxy:
        return ""
    if "://" not in proxy and proxy.count(":") >= 3:
        host, port, user, password = proxy.split(":", 3)
        return f"http://{user}:{password}@{host}:{port}"
    if "://" not in proxy:
        return "http://" + proxy
    return proxy


PROXY = normalize_proxy(DEFAULT_PROXY)

# Direct opener for the Steel API (never through a proxy itself).
OP = urllib.request.build_opener()


def get(url: str, headers: dict | None = None) -> bytes:
    h = {"Accept": "application/json, */*", "User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, method="GET")
    try:
        with OP.open(req, timeout=45) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %s %s %s" % (e.code, url, e.read()[:200])) from e


def steel_health() -> bool:
    """HTTP reachability of the Steel API = healthy (browser starts on demand)."""
    try:
        req = urllib.request.Request(STEEL_HEALTH_URL, headers={"User-Agent": UA})
        with OP.open(req, timeout=10) as r:
            raw = r.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except ValueError:
            data = {}
        p(
            f"[health] {STEEL_BASE} -> status={data.get('status')!r} "
            f"browser={data.get('browser')!r} browserRunning={data.get('browserRunning')!r}"
        )
        return True
    except Exception as e:
        p(f"[!] Steel health check failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Combo extraction / storage (unchanged)
# ---------------------------------------------------------------------------
def matches(text: str, keyword: str) -> bool:
    return keyword.lower() in (text or "").lower()


def init_db(path: str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS combos (
            email TEXT NOT NULL,
            password TEXT NOT NULL,
            PRIMARY KEY (email, password)
        )
        """
    )
    conn.commit()
    return conn


DB_LOCK = threading.Lock()
DB: sqlite3.Connection | None = None


def is_ms_email(email: str) -> bool:
    email = (email or "").lower().strip()
    if "@" not in email:
        return False
    domain = email.rsplit("@", 1)[-1]
    root = domain.split(".")[0] if domain else ""
    return root in ("hotmail", "outlook", "live", "msn")


def extract_ms_combos(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for m in COMBO_RE.finditer(text or ""):
        email = m.group(1).strip().lower()
        password = m.group(3).strip()
        if not is_ms_email(email) or not password:
            continue
        if password.lower() in ("null", "undefined", "password", "pass", "123456"):
            continue
        if len(password) > 128:
            continue
        key = (email, password)
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def save_combos_db(combos: list[tuple[str, str]]) -> int:
    global DB
    if not combos:
        return 0
    with DB_LOCK:
        if DB is None:
            DB = init_db()
        added = 0
        for email, password in combos:
            cur = DB.execute(
                "SELECT 1 FROM combos WHERE email = ? AND password = ? LIMIT 1",
                (email, password),
            )
            if cur.fetchone():
                continue
            DB.execute("INSERT INTO combos(email, password) VALUES (?,?)", (email, password))
            added += 1
        if added:
            DB.commit()
    if added:
        bump("combos", added)
        p(f" [+] DB Added {added} new combos (parsed {len(combos)} total from text) -> {DB_PATH}")
    return added


def ingest_text(source: str, paste_url: str, text: str) -> int:
    combos = extract_ms_combos(text)
    return save_combos_db(combos)


def save_hit(source: str, keyword: str, title: str, url: str, body: str) -> str:
    ingest_text(source, url, (title or "") + "\n" + (body or ""))
    safe = re.sub(r"[^\w.\-]+", "_", (title or "paste")[:80]).strip("_") or "paste"
    folder = os.path.join(OUT_DIR, keyword)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "%s_%s.txt" % (source, safe))
    n = 1
    while os.path.exists(path):
        path = os.path.join(folder, "%s_%s_%d.txt" % (source, safe, n))
        n += 1
    with open(path, "w", encoding="utf-8", errors="replace") as f:
        f.write("URL: %s\nTITLE: %s\nKEYWORD: %s\n\n%s\n" % (url, title, keyword, body))
    return path


# ---------------------------------------------------------------------------
# Steel scrape client — semaphore-bounded, retrying, 429-cooling
# ---------------------------------------------------------------------------
def _execute_steel_scrape(url: str) -> dict:
    """POST /v1/scrape — one HTTP round trip. Caller holds a semaphore slot."""
    body: dict = {
        "url": url,
        "format": ["markdown", "html"],
    }
    if PROXY:
        body["proxyUrl"] = PROXY

    req = urllib.request.Request(
        STEEL_SCRAPE_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": UA,
        },
        method="POST",
    )
    try:
        with OP.open(req, timeout=STEEL_HTTP_TIMEOUT) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        err_body = e.read()[:500].decode("utf-8", errors="replace")
        if e.code == 429:
            try:
                retry_after = float(e.headers.get("Retry-After") or 0)
            except (TypeError, ValueError):
                retry_after = 0.0
            raise RateLimitedError(f"Steel rate limited: {err_body}", retry_after or 5.0) from e
        if e.code in (408, 425, 500, 502, 503, 504, 521, 522, 524):
            raise TransientError(f"Steel scrape HTTP {e.code}: {err_body}") from e
        raise SteelScrapeError(f"Steel scrape HTTP {e.code}: {err_body}") from e
    except urllib.error.URLError as e:
        raise TransientError(f"Steel unreachable: {e.reason}") from e
    except (TimeoutError, socket.timeout, ConnectionError, OSError) as e:
        raise TransientError(f"Steel connection failed: {e}") from e

    try:
        data = json.loads(raw)
    except ValueError:
        low = raw.lower()
        if any(m in low for m in TRANSIENT_MARKERS):
            raise TransientError(f"Steel scrape returned a non-JSON error page: {raw[:200]}")
        raise SteelScrapeError(f"Steel scrape returned non-JSON: {raw[:200]}")

    if isinstance(data, dict) and data.get("message") and not data.get("content"):
        msg = str(data.get("message"))
        low = msg.lower()
        if any(m in low for m in TRANSIENT_MARKERS):
            raise TransientError(f"Steel scrape error: {msg}")
        raise SteelScrapeError(f"Steel scrape error: {msg}")

    content = (data.get("content") or {}) if isinstance(data, dict) else {}
    metadata = (data.get("metadata") or {}) if isinstance(data, dict) else {}
    return {
        "markdown": content.get("markdown") or "",
        "html": content.get("html") or "",
        "metadata": metadata,
    }


def steel_fetch(url: str, label: str = "") -> dict:
    """Fetch via Steel: one concurrency slot per in-flight request, transient
    retries with backoff, global 429 cooldown. Slots are released before any
    backoff sleep, so a retrying worker never wastes a server pool slot."""
    transient_attempt = 0
    rate_attempts = 0
    while True:
        _wait_rate_limit()
        if not _scrape_sem.acquire(timeout=15):
            continue
        gauge(1)
        tag = label or url
        sleep_s = 0.0
        try:
            p(
                f"[*] steel scrape (active={in_flight()}/{effective_concurrency()}) -> {tag}"
            )
            data = _execute_steel_scrape(url)
            bump("scrapes")
            blob = (data.get("markdown") or "") + (data.get("html") or "")
            congested = is_challenge_error(blob) or is_challenge_error(
                (data.get("metadata") or {}).get("title") or ""
            )
            if congested:
                bump("challenges")
            note_outcome(congested)
            return data
        except RateLimitedError as e:
            bump("rate_limited")
            bump("challenges")
            note_outcome(True)
            rate_attempts += 1
            set_cooldown(e.retry_after)
            if rate_attempts >= 8:
                raise
            sleep_s = e.retry_after
            p(f"[!] Rate limited. Cooling all workers down {sleep_s:.0f}s...")
        except TransientError as e:
            bump("retries")
            transient_attempt += 1
            if transient_attempt >= 4:
                raise
            sleep_s = min(5.0 * transient_attempt, 25.0)
            p(
                f"[!] Transient Steel error (attempt {transient_attempt}/3): {e}. "
                f"Retry in {sleep_s:.0f}s"
            )
        finally:
            gauge(-1)
            _scrape_sem.release()
        if sleep_s > 0:
            time.sleep(sleep_s)


# ---------------------------------------------------------------------------
# HTML / challenge helpers (unchanged)
# ---------------------------------------------------------------------------
def strip_tags(html: str) -> str:
    html = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>", "\n", html)
    html = re.sub(r"(?is)</p>", "\n", html)
    html = re.sub(r"(?is)<[^>]+>", " ", html)
    return (
        html.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#039;", "'")
    )


def unescape_entities(text: str) -> str:
    return (
        text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&#039;", "'")
    )


def is_skippable_error(content: str) -> bool:
    content_lower = (content or "").lower()
    has_memory = "allowed memory size" in content_lower and "exhausted" in content_lower
    has_502 = "bad gateway" in content_lower and "502" in content_lower
    return has_memory or has_502


def is_challenge_error(content: str) -> bool:
    content_lower = (content or "").lower()
    return (
        "performing security verification" in content_lower
        or "verification successful. waiting for" in content_lower
        or "just a moment" in content_lower
    )


# ---------------------------------------------------------------------------
# pasted.pw — list pages (run on the shared executor)
# ---------------------------------------------------------------------------
def fetch_list_page(page: int) -> list[dict]:
    """Scrape one recent.php page and return its items.

    Raises PageSkipped when the page is unparsable (challenge persisted,
    server 502/memory error, repeated transient failures). Returns [] at the
    end of the listing.
    """
    url = PASTED + "/recent.php" if page <= 1 else PASTED + "/recent.php?page=%d" % page
    last_err: Exception | None = None
    for attempt in range(1, 4):
        try:
            data = steel_fetch(url, label=f"list page {page}")
        except Exception as e:  # transient / rate-limit / hard API error
            last_err = e
            p(f"[!] Error fetching list page {page} (attempt {attempt}/3): {e}")
            if attempt < 3:
                time.sleep(3.0 * attempt)
            continue

        md = data.get("markdown") or ""
        html = data.get("html") or ""
        blob = md + "\n" + html
        title = (data.get("metadata") or {}).get("title") or ""

        if is_skippable_error(blob):
            raise PageSkipped(
                f"Skippable server error (Memory/502) on pasted.pw list page {page}"
            )
        if is_challenge_error(blob) or is_challenge_error(title):
            last_err = RuntimeError("Cloudflare security verification challenge")
            p(f"[!] Cloudflare challenge on list page {page} (attempt {attempt}/3)")
            if attempt < 3:
                time.sleep(5.0 * attempt)
            continue

        items: list[dict] = []
        seen_ids: set[str] = set()
        for m in re.finditer(r"\[([^\]]*)\]\(https?://pasted\.pw/view\.php\?id=(\d+)\)", md):
            title_i, pid = m.group(1).strip(), m.group(2)
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            items.append({"id": pid, "title": title_i})
        for m in re.finditer(r"view\.php\?id=(\d+)", blob):
            pid = m.group(1)
            if pid not in seen_ids:
                seen_ids.add(pid)
                items.append({"id": pid, "title": ""})
        return items

    raise PageSkipped(f"pasted.pw list page {page} failed after 3 attempts: {last_err}")


# ---------------------------------------------------------------------------
# pasted.pw — paste content (run on the shared executor)
# ---------------------------------------------------------------------------
def process_item(item: dict) -> tuple[str, str, str | None]:
    """Fetch one paste: raw.php first, view.php as fallback/title source.

    Returns (title, body, skip_reason) — skip_reason is None on success.
    Raises when both sources failed transiently (the pipeline re-queues it).
    """
    pid = item["id"]
    # Backoff requested by the pipeline after a CF challenge (sleeps in the
    # worker thread — never while holding a scrape slot).
    retry_after = item.get("retry_after", 0)
    if retry_after > time.time():
        time.sleep(retry_after - time.time())
    raw_url = PASTED + "/raw.php?id=" + pid
    view_url = PASTED + "/view.php?id=" + pid
    list_title = (item.get("title") or "").strip()
    title = ""
    body = ""

    # 1) raw.php — cheapest source of the paste body.
    try:
        raw_data = steel_fetch(raw_url, label=f"raw {pid}")
        raw_text = (raw_data.get("markdown") or raw_data.get("html") or "").strip()
        if raw_text and not is_skippable_error(raw_text) and not is_challenge_error(raw_text):
            candidate = strip_tags(raw_text) if "<" in raw_text[:200] else raw_text
            candidate = unescape_entities(candidate)
            if candidate and len(candidate) > 10:
                body = candidate
    except Exception as e:
        p(f"[!] raw.php failed for {pid}: {e}")

    # 2) view.php — needed when the raw body failed/challenged, when the list
    #    page had no title for the filename, or with --always-view.
    if body and list_title and not ALWAYS_VIEW:
        return (list_title, body, None)

    try:
        data = steel_fetch(view_url, label=f"view {pid}")
    except Exception as e:
        if body:
            p(f"[!] view.php failed for {pid} (kept raw body): {e}")
            return (list_title or ("paste-" + pid), body, None)
        raise

    md = data.get("markdown") or ""
    html = data.get("html") or ""

    if is_challenge_error(md) or is_challenge_error(html):
        if body:
            return (list_title or ("paste-" + pid), body, None)
        # Challenges under concurrent load often clear on a later, spaced-out
        # attempt — let the pipeline re-queue instead of losing the paste.
        raise ChallengeRetry(f"Cloudflare challenge on view.php for paste {pid}")
    if is_skippable_error(md) or is_skippable_error(html):
        if body:
            return (list_title or ("paste-" + pid), body, None)
        return ("paste-" + pid, "", "server error (memory/502) on view.php")

    for line in md.splitlines():
        line = line.strip()
        if line and not line.startswith("[") and line.lower() not in ("navigation", "select an option"):
            if not title and len(line) < 120 and "pasted.pw" not in line.lower():
                title = line
                break
    if not body:
        hm = re.search(
            r'<textarea[^>]+id="hidden-paste-content"[^>]*>(.*?)</textarea>', html, re.I | re.S
        )
        body = unescape_entities(hm.group(1) if hm else md)

    return (title or list_title or ("paste-" + pid), body, None)


# ---------------------------------------------------------------------------
# pasted.pw — pipeline: windowed list-page producer + capped content consumers
# ---------------------------------------------------------------------------
def _stats_line(pages_ok: int, pages_skipped: int, pending_items: int, elapsed: float) -> str:
    with STATS_LOCK:
        s = dict(STATS)
        infl = IN_FLIGHT
    rate = (s["scrapes"] / elapsed * 60.0) if elapsed > 0 else 0.0
    return (
        f"scrapes={s['scrapes']} (~{rate:.1f}/min) "
        f"in_flight={infl}/{effective_concurrency()} (target={STEEL_MAX_CONCURRENCY}) | "
        f"pages ok={pages_ok} skipped={pages_skipped} | "
        f"items ok={s['items_ok']} skipped={s['items_skipped']} failed={s['items_failed']} | "
        f"hits={s['hits']} combos={s['combos']} | backlog={pending_items} elapsed={elapsed:.0f}s"
    )


def run_pasted(keywords: list[str], start_page: int = 1, max_pages: int = 0) -> None:
    if not steel_health():
        p("pasted.pw: Steel API is not healthy. Check STEEL_BASE / setup.sh.")
        return

    page_look = max(2, STEEL_MAX_CONCURRENCY)          # list pages kept in flight
    item_cap = max(6, STEEL_MAX_CONCURRENCY * 6)       # content futures kept pending
    workers = STEEL_MAX_CONCURRENCY * 2                # extra threads hold backoff waits

    p(
        f"[*] Starting pasted.pw via Steel ({STEEL_BASE}) from page {start_page} "
        f"concurrency={STEEL_MAX_CONCURRENCY}"
        f"{' (adaptive)' if ADAPTIVE else ' (fixed)'} "
        f"workers={workers} page_lookahead={page_look} item_cap={item_cap} "
        f"timeout={STEEL_HTTP_TIMEOUT}s "
        f"proxy={'yes' if PROXY else 'no'} max_pages={max_pages or 'all'}"
    )

    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="scrape")
    seen_ids: set[str] = set()
    item_deque: deque[dict] = deque()
    pending_pages: dict[Future, int] = {}   # future -> page number
    pending_items: dict[Future, dict] = {}  # future -> item

    next_page = start_page
    pages_submitted = pages_ok = pages_skipped = 0
    fail_streak = 0
    pages_ended = False
    end_reason: str | None = None
    t0 = time.time()
    last_stats = t0

    def handle_page_result(fut: Future, page: int) -> None:
        nonlocal pages_ok, pages_skipped, fail_streak, pages_ended, end_reason
        try:
            items = fut.result()
        except PageSkipped as e:
            if pages_ended:
                return
            pages_skipped += 1
            fail_streak += 1
            bump("pages_skipped")
            p(f"[!] {e}")
            if fail_streak >= 10:
                pages_ended = True
                end_reason = "10 consecutive page failures"
                p("[!] Too many consecutive page failures. Stopping.")
        except Exception as e:
            if pages_ended:
                return
            pages_skipped += 1
            fail_streak += 1
            bump("pages_skipped")
            p(f"[✗ TASK FAILED] pasted.pw list page {page}: {e}")
            if fail_streak >= 10:
                pages_ended = True
                end_reason = "10 consecutive page failures"
                p("[!] Too many consecutive page failures. Stopping.")
        else:
            if not items:
                # End of the listing — but keep processing pages that were
                # already in flight (a later page can finish first).
                if not pages_ended:
                    pages_ended = True
                    end_reason = "end of pages (no items)"
                    p(f"[*] pasted.pw end of pages at page {page} (no items).")
                return
            fail_streak = 0
            pages_ok += 1
            bump("pages_ok")
            fresh = []
            for it in items:
                if it["id"] in seen_ids:
                    continue
                seen_ids.add(it["id"])
                fresh.append(it)
            item_deque.extend(fresh)
            p(
                f"[✓ TASK COMPLETED] pasted.pw list page {page}: {len(items)} items "
                f"({len(fresh)} new, backlog={len(item_deque)})"
            )

    def handle_item_result(fut: Future, it: dict) -> None:
        try:
            title, body, skip_reason = fut.result()
        except ChallengeRetry as e:
            attempt = it.get("attempt", 1)
            if attempt < 3:
                it["attempt"] = attempt + 1
                it["retry_after"] = time.time() + 5.0 * attempt
                p(
                    f"[!] {e} — requeueing paste {it['id']} in {5 * attempt:.0f}s "
                    f"(attempt {it['attempt']}/3)"
                )
                pending_items[executor.submit(process_item, it)] = it
            else:
                bump("items_skipped")
                p(
                    f"[!] Skipped paste {it['id']}: Cloudflare challenge persisted "
                    f"after 3 attempts"
                )
            return
        except Exception as e:
            attempt = it.get("attempt", 1)
            if attempt < 3:
                it["attempt"] = attempt + 1
                p(f"[!] Retry paste {it['id']} attempt {it['attempt']}/3: {e}")
                pending_items[executor.submit(process_item, it)] = it
            else:
                bump("items_failed")
                p(f"[✗ TASK FAILED] Error processing paste {it['id']}: {e}")
            return

        if skip_reason:
            bump("items_skipped")
            p(f"[!] Skipped paste {it['id']}: {skip_reason}")
            return

        bump("items_ok")
        title = title or it.get("title") or it["id"]
        text = title + "\n" + body
        url = PASTED + "/view.php?id=" + it["id"]
        ingest_text("pasted", url, text)

        hit_found = False
        for k in keywords:
            if matches(text, k) or matches(title, k):
                path = save_hit("pasted", k, title, url, text)
                bump("hits")
                p(f" HIT [{k}] saved -> {path}")
                hit_found = True
        p(f"[✓ TASK COMPLETED] pasted.pw item ID: {it['id']} (Hits match: {hit_found})")

    try:
        while True:
            # Producer: keep a window of list pages in flight.
            if not pages_ended:
                while len(pending_pages) < page_look and (
                    max_pages <= 0 or pages_submitted < max_pages
                ):
                    fut = executor.submit(fetch_list_page, next_page)
                    pending_pages[fut] = next_page
                    next_page += 1
                    pages_submitted += 1

            # Consumers: fill remaining capacity with paste content jobs.
            while item_deque and len(pending_items) < item_cap:
                it = item_deque.popleft()
                pending_items[executor.submit(process_item, it)] = it

            if not pending_pages and not pending_items:
                break

            done, _ = futures_wait(
                set(pending_pages) | set(pending_items),
                timeout=15.0,
                return_when=FIRST_COMPLETED,
            )

            now = time.time()
            if now - last_stats >= 20:
                p(
                    "[stats] "
                    + _stats_line(
                        pages_ok, pages_skipped, len(pending_items) + len(item_deque), now - t0
                    )
                )
                last_stats = now

            for fut in done:
                if fut in pending_pages:
                    page = pending_pages.pop(fut)
                    handle_page_result(fut, page)
                else:
                    it = pending_items.pop(fut)
                    handle_item_result(fut, it)
    except KeyboardInterrupt:
        p("[!] Interrupted — cancelling queued scrapes...")
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    elapsed = time.time() - t0
    p("[✓ TASK COMPLETED] All pasted.pw workers finished.")
    p(
        f"    reason: {end_reason or 'all queued work processed'} | "
        + _stats_line(pages_ok, pages_skipped, 0, elapsed)
    )


# ---------------------------------------------------------------------------
# pasteview.com (plain API — unchanged behavior)
# ---------------------------------------------------------------------------
def run_pasteview(keywords: list[str]) -> None:
    cursor = ""
    as_of = ""
    pages = 0
    h = {"Referer": PASTEVIEW + "/discover"}
    if PV_TOKEN:
        h["Authorization"] = "Bearer " + PV_TOKEN
    while True:
        pages += 1
        if PV_MAX_PAGES and pages > PV_MAX_PAGES:
            break
        q = {
            "limit": "30",
            "publicArchiveFeed": "true",
            "sortMode": PV_SORT,
            "sortOrder": "desc",
            "privacyFilters": "public",
        }
        if cursor:
            q["cursor"] = cursor
        if as_of:
            q["asOf"] = as_of
        try:
            raw = get(PASTEVIEW + "/api/pastes/archive?" + urllib.parse.urlencode(q), h)
            data = json.loads(raw)
        except Exception as e:
            print("[✗ TASK FAILED] pasteview list error:", e)
            break
        result = data.get("result") or {}
        items = result.get("items") or []
        print(f"pasteview page {pages} items found: {len(items)}")

        for it in items:
            pid = it.get("_id") or ""
            title = it.get("title") or pid
            preview = "\n".join(((it.get("feedPreview") or {}).get("lines")) or [])
            text = title + "\n" + preview
            url = PASTEVIEW + "/paste/" + pid
            ingest_text("pasteview", url, text)
            for k in keywords:
                if matches(text, k):
                    print(f" HIT [{k}] saved -> {save_hit('pasteview', k, title, url, text)}")
            print(f"[✓ TASK COMPLETED] Pasteview item processed: {pid}")

        cursor = result.get("nextCursor") or ""
        as_of = result.get("asOf") or as_of
        print(f"[✓ TASK COMPLETED] Pasteview page {pages} finished.")
        if not result.get("hasMoreOlder") or not cursor:
            break


# ---------------------------------------------------------------------------
# uploadery.com (plain API — unchanged behavior)
# ---------------------------------------------------------------------------
def run_uploadery(keywords: list[str]) -> None:
    h = {"Referer": UPLOADERY + "/collections/documents"}
    if U_COOKIES:
        h["Cookie"] = U_COOKIES
    for col in U_COLLECTIONS:
        page = 1
        while True:
            if U_MAX_PAGES and page > U_MAX_PAGES:
                break
            q = urllib.parse.urlencode({"collection": col, "page": str(page), "limit": "50"})
            try:
                raw = get(UPLOADERY + "/api/explorer/collections?" + q, h)
                data = json.loads(raw)
            except Exception as e:
                print(f"[✗ TASK FAILED] uploadery list error for collection {col}:", e)
                break
            ups = data.get("uploads") or []
            print(f"uploadery {col} page {page} items: {len(ups)} (total {data.get('totalCount')})")

            for up in ups:
                title = up.get("title") or up.get("slug") or up.get("id") or ""
                url = UPLOADERY + "/u/" + (up.get("slug") or up.get("id") or "")
                ingest_text("uploadery", url, title)
                for k in keywords:
                    if matches(title, k):
                        print(f" HIT [{k}] saved -> {save_hit('uploadery', k, title, url, title)}")
                print(f"[✓ TASK COMPLETED] Uploadery item processed: {up.get('id') or up.get('slug')}")

            print(f"[✓ TASK COMPLETED] Uploadery collection '{col}' page {page} finished.")
            if not data.get("hasMore"):
                break
            page += 1


def main() -> None:
    global DB, PROXY, STEEL_BASE, STEEL_SCRAPE_URL, STEEL_HEALTH_URL
    global STEEL_MAX_CONCURRENCY, STEEL_HTTP_TIMEOUT, _scrape_sem, ALWAYS_VIEW
    global ADAPTIVE, _CONC_TARGET, _CONC_EFFECTIVE

    parser = argparse.ArgumentParser(
        description=(
            "Scraper using self-hosted Steel Browser — fully concurrent "
            "/v1/scrape pipeline (isolated browser per job, server pool of 4)"
        )
    )
    parser.add_argument("-pv", "--pasteview", action="store_true")
    parser.add_argument("-u", "--uploadery", action="store_true")
    parser.add_argument("-p", "--pasted", action="store_true")
    parser.add_argument("-pg", "--page", type=int, default=1, help="Starting page for pasted.pw")
    parser.add_argument(
        "--max-pages",
        type=int,
        default=0,
        help="Stop after N pasted.pw list pages (0 = run to the end)",
    )
    parser.add_argument("-k", "--keyword", action="append")
    parser.add_argument("--steel-base", default=None, help="Steel API base URL")
    parser.add_argument("--proxy", default=None, help="Proxy URL or host:port:user:pass")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help="Concurrent Steel scrapes (default 4 = SCRAPE_MAX_CONCURRENCY)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=None,
        help="Per-request HTTP timeout in seconds (default 300)",
    )
    parser.add_argument(
        "--no-adaptive",
        action="store_true",
        help="Pin concurrency at --concurrency (never back off on CF challenges)",
    )
    parser.add_argument(
        "--always-view",
        action="store_true",
        help="Always fetch view.php per paste (old behavior; default skips it "
        "when raw.php gave a body and the list page had a title)",
    )
    args = parser.parse_args()

    if args.steel_base:
        STEEL_BASE = args.steel_base.rstrip("/")
        STEEL_SCRAPE_URL = f"{STEEL_BASE}/v1/scrape"
        STEEL_HEALTH_URL = f"{STEEL_BASE}/v1/health"
    if args.proxy is not None:
        PROXY = normalize_proxy(args.proxy)
    if args.concurrency:
        STEEL_MAX_CONCURRENCY = max(1, args.concurrency)
    if args.timeout:
        STEEL_HTTP_TIMEOUT = max(30, args.timeout)
    ALWAYS_VIEW = bool(args.always_view)
    ADAPTIVE = not args.no_adaptive
    # Fresh process: effective starts at the configured target.
    _CONC_TARGET = STEEL_MAX_CONCURRENCY
    _CONC_EFFECTIVE = STEEL_MAX_CONCURRENCY
    _RECENT_OUTCOMES.clear()
    _scrape_sem = AdaptiveSlots(STEEL_MAX_CONCURRENCY)

    selected = []
    if args.pasteview:
        selected.append("pasteview")
    if args.uploadery:
        selected.append("uploadery")
    if args.pasted:
        selected.append("pasted")
    sources_to_run = selected if selected else SOURCES
    kws = [k.strip() for k in (args.keyword if args.keyword else KEYWORDS) if k.strip()]
    if not kws:
        sys.exit("set KEYWORDS")

    os.makedirs(OUT_DIR, exist_ok=True)
    DB = init_db(DB_PATH)

    print("keywords", kws)
    print("database", os.path.abspath(DB_PATH))
    print("active sources", sources_to_run)
    print("steel base", STEEL_BASE)
    print("proxy", (PROXY[:56] + "...") if PROXY else "(none)")
    print("concurrency", STEEL_MAX_CONCURRENCY, "adaptive", ADAPTIVE)
    print("timeout_s", STEEL_HTTP_TIMEOUT)
    print("always_view", ALWAYS_VIEW)

    if not steel_health():
        sys.exit(f"Steel API not healthy at {STEEL_BASE} — start with setup.sh first")

    if "pasteview" in sources_to_run:
        run_pasteview(kws)
    if "uploadery" in sources_to_run:
        run_uploadery(kws)
    if "pasted" in sources_to_run:
        run_pasted(kws, start_page=args.page, max_pages=max(0, args.max_pages))

    n = DB.execute("SELECT COUNT(*) FROM combos").fetchone()[0]
    with STATS_LOCK:
        s = dict(STATS)
    print("[✓ TASK COMPLETED] All scraping tasks finished successfully.")
    print(
        f"scrapes={s['scrapes']} retries={s['retries']} rate_limited={s['rate_limited']} "
        f"hits={s['hits']}"
    )
    print("done ->", os.path.abspath(OUT_DIR))
    print("data.db combos:", n)


if __name__ == "__main__":
    main()
