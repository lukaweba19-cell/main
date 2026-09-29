import { Page, chromium } from "patchright";
import fs from "node:fs";
import os from "os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  resolveBrowser,
  getCloakStealthArgs,
  BrowserNotFoundError,
} from "../../utils/resolve-browser.js";
import { getExtensionPaths } from "../../utils/extensions.js";
import {
  snapshotPage,
  hasRealContent,
} from "../../utils/scrape/content-ready.js";
import { ScrapePool } from "../../utils/scrape/scrape-pool.js";
import { acquireXvfbDisplay, type XvfbDisplay } from "./xvfb-display.js";

/**
 * XReactor runs COMPLETELY outside the Steel session system: every checked
 * URL gets its own throwaway CloakBrowser process with a unique temporary
 * profile, closed and deleted afterwards.
 *
 * TRUE CONCURRENCY with per-check recordings:
 * - Each check acquires its OWN Xvfb display (:11, :12, ...) and launches its
 *   browser there, so concurrent checks never share a screen and each video
 *   films exactly one browser (no cross-contamination, no black bars).
 * - The shared Steel display (:10) is never touched, so /v1/scrape keeps
 *   working in parallel with xreactor traffic.
 * - The browser window is sized to FILL the display so the recording frame
 *   is exactly the browser (viewport 1440x900 + chrome window decorations).
 */

/** Cap on simultaneously live isolated browsers (memory guard for the VM). */
const maxConcurrent = Math.max(
  1,
  parseInt(process.env.XREACTOR_MAX_CONCURRENT || "4", 10) || 4,
);
export const xreactorBrowserPool = new ScrapePool(maxConcurrent, 30_000);

export interface IsolatedBrowser {
  page: Page;
  /** Dedicated Xvfb display this browser runs on (null = shared :10 fallback). */
  display: XvfbDisplay | null;
  close: () => Promise<void>;
}

/**
 * Launches a private CloakBrowser instance for one check.
 *
 * - Unique tmp profile dir per launch (removed on close) => no cross-request
 *   state, no profile lock contention, fresh fingerprint seed each time.
 * - The nopecha extension loads exactly like in the main stack so challenge
 *   pages still get solved.
 * - When `display` is provided the browser runs on that dedicated Xvfb screen
 *   and its window is resized to fill it; otherwise it falls back to the
 *   shared DISPLAY (recording quality degrades, checks still work).
 */
export async function launchIsolatedBrowser(
  log: (msg: string) => void,
  display?: XvfbDisplay | null,
): Promise<IsolatedBrowser> {
  const resolved = resolveBrowser(); // throws BrowserNotFoundError when missing
  const profileDir = path.join(os.tmpdir(), `xreactor-profile-${randomUUID()}`);
  await fs.promises.mkdir(profileDir, { recursive: true });

  const extensionPaths = await getExtensionPaths();
  const width = display?.width ?? 1440;
  const height = (display?.height ?? 900) - 50; // room for window decorations

  const args = [
    ...getCloakStealthArgs(), // --no-sandbox, --fingerprint=<seed>, --fingerprint-platform=linux
    "--test-type", // suppress the --no-sandbox infobar (required as root)
    "--disable-dev-shm-usage", // /tmp shm is tiny; keeps many browsers stable
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    `--window-size=${width},${height}`,
    "--window-position=0,0",
    "--start-maximized",
    ...(extensionPaths.length
      ? [
          `--load-extension=${extensionPaths.join(",")}`,
          `--disable-extensions-except=${extensionPaths.join(",")}`,
        ]
      : []),
  ];

  log(
    `[xreactor] launching isolated browser (engine=${resolved.engine}, profile=${profileDir}, display=${display?.display ?? (process.env.DISPLAY || ":10")})`,
  );
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // headful on the Xvfb display, same as the main stack
    executablePath: resolved.executablePath,
    viewport: { width: 1440, height: 900 },
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    timeout: 60_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    env: { ...process.env, DISPLAY: display?.display || (process.env.DISPLAY || ":10") },
  });

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  const close = async (): Promise<void> => {
    try {
      await context.close();
    } catch {
      // already dead
    }
    // Best-effort profile cleanup; old profiles are also swept by the
    // maintenance loop in case the process crashed before cleanup.
    fs.rm(profileDir, { recursive: true, force: true }, () => {});
  };

  return { page, display: display ?? null, close };
}

export { BrowserNotFoundError as XReactorBrowserNotFoundError };

/**
 * Lightweight page-ready detection for compliance checks — exits the moment
 * REAL CONTENT is present, never before:
 *
 *   1. `waitForLoadState("load")` rides the browser's load event.
 *   2. One snapshot: content present => done (typical page: 1-2s).
 *   3. Challenge interstitial (or still-rendering page): poll every 300ms and
 *      exit the instant real content shows up. Cloudflare solves trigger a
 *      reload, so "challenge flag gone" is NOT enough — we keep polling
 *      through the reload until the reloaded page actually has text.
 *      Transient null snapshots during navigation are retried, never "done".
 *
 * The ceiling (XREACTOR_CHALLENGE_TIMEOUT_MS, default 20s) is only a failure
 * bound for pages that never render content; happy pages leave immediately.
 */
export async function waitForCheckReady(
  page: Page,
  opts: { readyTimeoutMs?: number; challengeTimeoutMs?: number } = {},
): Promise<{ waitedMs: number; challengeCleared: boolean; contentReady: boolean }> {
  const start = Date.now();
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8_000;
  const challengeTimeoutMs =
    opts.challengeTimeoutMs ??
    Math.max(5_000, parseInt(process.env.XREACTOR_CHALLENGE_TIMEOUT_MS || "20000", 10) || 20_000);

  // 1) Event-driven load wait: returns immediately when already loaded.
  await page.waitForLoadState("load", { timeout: readyTimeoutMs }).catch(() => {});

  if (page.isClosed()) {
    return { waitedMs: Date.now() - start, challengeCleared: false, contentReady: false };
  }

  // 2) Fast path: content already present.
  let snap = await snapshotPage(page).catch(() => null);
  if (snap && hasRealContent(snap)) {
    return { waitedMs: Date.now() - start, challengeCleared: false, contentReady: true };
  }

  // 3) Poll until real content exists — challenge solves reload the page, so
  //    keep polling through the reload and out the other side.
  let challengeCleared = false;
  let contentReady = false;
  const deadline = Date.now() + challengeTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (page.isClosed()) break;
    snap = await snapshotPage(page).catch(() => null);
    if (!snap) continue; // navigation in flight — retry, never treat as done
    if (snap.challenge) continue; // still solving
    challengeCleared = true;
    if (hasRealContent(snap)) {
      contentReady = true;
      break; // content just appeared — done, zero extra dwell
    }
    // Challenge cleared but content not rendered yet: keep polling.
  }
  return { waitedMs: Date.now() - start, challengeCleared, contentReady };
}

/**
 * Sweeps leftover xreactor profile dirs from crashed runs.
 * maxAgeMs <= 0 removes every leftover regardless of age (daily flush).
 */
export function sweepStaleProfiles(maxAgeMs = 60 * 60 * 1000): number {
  const tmp = os.tmpdir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("xreactor-profile-")) continue;
      const dir = path.join(tmp, name);
      try {
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if (maxAgeMs <= 0 || age > maxAgeMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // racing with another sweep — ignore
      }
    }
  } catch {
    // tmpdir unreadable — nothing to do
  }
  return removed;
}
