#!/usr/bin/env python3
"""
nodriver sidecar launcher for the Steel Browser API.

Speaks a tiny JSON-over-HTTP protocol on 127.0.0.1 (default :9224):

  POST /launch
      {
        "profile":      "/abs/path",        # user-data-dir; REQUIRED — this is what
                                            # makes the fingerprint persistent (same
                                            # dir => same identity, every launch)
        "port":         9300,               # desired remote-debugging-port (0 = pick free)
        "display":      ":11",              # X display to run headful on
        "window":       [1440, 900],        # --window-size
        "executable":   "/usr/bin/google-chrome",  # optional override
        "extensions":   ["/abs/ext1", ...], # unpacked extension dirs to load
        "browserArgs":  ["--flag", ...],    # extra chromium args
        "lang":         "en-US",
        "env":          {"TZ": "..."},      # per-launch env (DISPLAY/TZ via wrapper)
        "cfVerify":     false               # run nodriver-cf-verify on the seed tab
      }
      -> 200 {"ok": true, "webSocketDebuggerUrl": "ws://...", "pid": 4242,
              "port": 9300, "cfVerifyAvailable": true}
      -> 4xx/5xx {"ok": false, "error": "..."}

  POST /cfverify  {"port": 9300}  -> run the Cloudflare Turnstile verify loop
                                    against a tab on that CDP port
  POST /close     {"pid": 4242}   -> terminate the browser started earlier

Every launched browser is started by nodriver itself (stealth defaults, CDP
flattened sessions, no webdriver) and exposed over its standard CDP endpoint so
the Node API can attach with Playwright's connectOverCDP.

Per-launch env: nodriver spawns Chrome inheriting the sidecar's environment, so
DISPLAY/TZ are delivered through a tiny wrapper script that execs the real
binary with the requested environment. exec() replaces the shell, so the PID
nodriver tracks IS the chrome process.

Python deps (installed by setup.sh into api/python/.venv):
  nodriver, aiohttp, nodriver-cf-verify (optional)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import signal
import socket
import stat
import sys
import tempfile
from pathlib import Path

from aiohttp import web

logging.basicConfig(
    level=os.environ.get("NODRIVER_SIDECAR_LOG", "info").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("nodriver-sidecar")

# pid -> {"browser": nodriver.Browser, "port": int, "wrapper": str | None}
BROWSERS: dict[int, dict] = {}

CF_VERIFY_AVAILABLE = False
try:  # optional: pip install nodriver-cf-verify
    from nodriver_cf_verify import CFVerify  # type: ignore

    CF_VERIFY_AVAILABLE = True
except Exception:  # pragma: no cover - optional dependency
    CFVerify = None  # type: ignore


def _recommended_args() -> list[str]:
    """nodriver-cf-verify's RECOMMENDED_BROWSER_ARGS — keeps background tabs
    from being throttled during concurrent checks."""
    return [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-component-update",
    ]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _write_env_wrapper(real_executable: str, env: dict[str, str]) -> str:
    """Create a wrapper script that exports env then execs the real browser."""
    fd, wrapper = tempfile.mkstemp(prefix="nodriver-wrap-", suffix=".sh")
    with os.fdopen(fd, "w") as f:
        f.write("#!/bin/sh\n")
        for key, value in (env or {}).items():
            f.write(f"export {key}={json.dumps(str(value))}\n")
        f.write(f'exec {json.dumps(real_executable)} "$@"\n')
    os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


async def _launch(payload: dict) -> dict:
    import nodriver as uc

    profile = payload.get("profile")
    if not profile:
        return {"ok": False, "error": "profile (user-data-dir) is required"}

    Path(profile).mkdir(parents=True, exist_ok=True)

    port = int(payload.get("port") or 0) or _free_port()
    display = payload.get("display") or os.environ.get("DISPLAY", ":10")
    window = payload.get("window") or [1920, 1080]
    executable = payload.get("executable") or os.environ.get("CHROME_EXECUTABLE_PATH") or None
    extensions = payload.get("extensions") or []
    lang = payload.get("lang") or "en-US"
    per_launch_env = dict(payload.get("env") or {})
    per_launch_env.setdefault("DISPLAY", display)
    want_cf_verify = bool(payload.get("cfVerify")) and CF_VERIFY_AVAILABLE

    args: list[str] = [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-dev-shm-usage",
        "--test-type",  # suppress the --no-sandbox infobar (VMs run as root)
        f"--window-size={int(window[0])},{int(window[1])}",
        "--window-position=0,0",
        *_recommended_args(),
        *(payload.get("browserArgs") or []),
    ]
    if extensions:
        joined = ",".join(str(e) for e in extensions)
        args.append(f"--load-extension={joined}")
        args.append(f"--disable-extensions-except={joined}")

    wrapper: str | None = None
    browser_executable = executable
    if per_launch_env:
        if not browser_executable:
            return {"ok": False, "error": "env requested but no executable resolved"}
        wrapper = _write_env_wrapper(browser_executable, per_launch_env)
        browser_executable = wrapper

    config = uc.Config(
        user_data_dir=profile,
        headless=False,  # always headful on Xvfb, same as the rest of the stack
        browser_executable_path=browser_executable,
        browser_args=args,
        sandbox=False,  # root on the VM; nodriver would auto-disable anyway
        lang=lang,
        host="127.0.0.1",
        port=port,
    )

    try:
        # nodriver needs a running loop; the sidecar IS the loop.
        browser = await uc.Browser.create(config)
    except Exception:
        if wrapper:
            try:
                os.unlink(wrapper)
            except OSError:
                pass
        raise

    ws = getattr(browser, "websocket_url", None)
    pid = getattr(browser, "_process_pid", None)

    if want_cf_verify and browser.tabs:
        try:
            verifier = CFVerify(_browser_tab=browser.tabs[0], _debug=False)  # type: ignore[operator]
            await verifier.verify(_max_retries=15, _interval_between_retries=1,
                                  _reload_page_after_n_retries=5)
            log.info("cf-verify: challenge cleared on seed tab")
        except Exception as exc:  # never fail the launch because of verify
            log.warning("cf-verify failed (continuing): %s", exc)

    if pid is not None:
        BROWSERS[int(pid)] = {"browser": browser, "port": port, "wrapper": wrapper}

    return {
        "ok": True,
        "webSocketDebuggerUrl": ws,
        "pid": pid,
        "port": port,
        "cfVerifyAvailable": CF_VERIFY_AVAILABLE,
    }


async def _close(payload: dict) -> dict:
    pid = payload.get("pid")
    entry = BROWSERS.pop(int(pid), None) if pid is not None else None
    if not entry:
        return {"ok": True, "note": "unknown pid (already gone?)"}

    wrapper = entry.get("wrapper")
    if wrapper:
        try:
            os.unlink(wrapper)
        except OSError:
            pass

    browser = entry.get("browser")
    try:
        if browser is not None:
            browser.stop()
    except Exception as exc:
        log.warning("browser.stop() failed for pid %s: %s", pid, exc)
    return {"ok": True}


async def _cfverify(payload: dict) -> dict:
    port = int(payload.get("port") or 0)
    if not CF_VERIFY_AVAILABLE:
        return {"ok": False, "error": "nodriver-cf-verify not installed"}
    if not port:
        return {"ok": False, "error": "port (CDP port) is required"}

    import nodriver as uc

    config = uc.Config(host="127.0.0.1", port=port, sandbox=False)
    browser = await uc.Browser.create(config)  # attaches to the running instance
    try:
        tabs = browser.tabs
        if not tabs:
            return {"ok": False, "error": "no tabs found on the running browser"}
        verifier = CFVerify(_browser_tab=tabs[0], _debug=False)  # type: ignore[operator]
        success = await verifier.verify(_max_retries=15, _interval_between_retries=1,
                                        _reload_page_after_n_retries=5)
        return {"ok": bool(success), "success": bool(success)}
    finally:
        # Detach without killing the browser we attached to.
        try:
            browser.stop()
        except Exception:
            # stop() on an attached (not spawned) browser just detaches; if it
            # kills the target we rely on the caller reaping by pid anyway.
            pass


async def handle_launch(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    try:
        result = await _launch(payload)
        return web.json_response(result, status=200 if result.get("ok") else 500)
    except Exception as exc:
        log.exception("launch failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_close(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    try:
        return web.json_response(await _close(payload))
    except Exception as exc:
        log.exception("close failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_cfverify(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    try:
        return web.json_response(await _cfverify(payload))
    except Exception as exc:
        log.exception("cfverify failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "browsers": len(BROWSERS),
        "cfVerify": CF_VERIFY_AVAILABLE,
        "python": sys.version.split()[0],
    })


async def _shutdown_browsers(*_args) -> None:
    for pid, entry in list(BROWSERS.items()):
        try:
            browser = entry.get("browser")
            if browser is not None:
                browser.stop()
        except Exception:
            pass
        wrapper = entry.get("wrapper")
        if wrapper:
            try:
                os.unlink(wrapper)
            except OSError:
                pass
    BROWSERS.clear()


def main() -> None:
    host = os.environ.get("NODRIVER_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("NODRIVER_SIDECAR_PORT", "9224"))

    app = web.Application(client_max_size=4 * 1024 * 1024)
    app.router.add_post("/launch", handle_launch)
    app.router.add_post("/close", handle_close)
    app.router.add_post("/cfverify", handle_cfverify)
    app.router.add_get("/health", handle_health)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.ensure_future(_shutdown_browsers()))
        except NotImplementedError:  # pragma: no cover
            pass

    log.info("nodriver sidecar listening on %s:%s (cfVerify=%s)", host, port, CF_VERIFY_AVAILABLE)
    web.run_app(app, host=host, port=port, loop=loop, print=None, shutdown_timeout=2)


if __name__ == "__main__":
    main()
