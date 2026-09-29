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

/**
 * XReactor runs COMPLETELY outside the Steel session system: every checked
 * URL gets its own throwaway CloakBrowser process with a unique temporary
 * profile, which is closed and deleted afterwards. Nothing is recorded and no
 * sessions appear in the UI. Multiple checks (across and within requests) run
 * simultaneously up to XREACTOR_MAX_CONCURRENT, so a batch of many URLs fans
 * out into parallel browsers instead of queueing on one shared instance.
 */

/** Cap on simultaneously live isolated browsers (memory guard for the VM). */
const maxConcurrent = Math.max(
  1,
  parseInt(process.env.XREACTOR_MAX_CONCURRENT || "4", 10) || 4,
);
export const xreactorBrowserPool = new ScrapePool(maxConcurrent, 30_000);

export interface IsolatedBrowser {
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launches a private CloakBrowser instance for one check.
 *
 * - Unique tmp profile dir per launch (removed on close) => no cross-request
 *   state, no profile lock contention, fresh fingerprint seed each time.
 * - The nopecha extension loads exactly like in the main stack so challenge
 *   pages still get solved.
 */
export async function launchIsolatedBrowser(log: (msg: string) => void): Promise<IsolatedBrowser> {
  const resolved = resolveBrowser(); // throws BrowserNotFoundError when missing
  const profileDir = path.join(os.tmpdir(), `xreactor-profile-${randomUUID()}`);
  await fs.promises.mkdir(profileDir, { recursive: true });

  const extensionPaths = await getExtensionPaths();
  const args = [
    ...getCloakStealthArgs(), // --no-sandbox, --fingerprint=<seed>, --fingerprint-platform=linux
    "--test-type", // suppress the --no-sandbox infobar (required as root)
    "--disable-dev-shm-usage", // /tmp shm is tiny; keeps many browsers stable
    ...(extensionPaths.length
      ? [
          `--load-extension=${extensionPaths.join(",")}`,
          `--disable-extensions-except=${extensionPaths.join(",")}`,
        ]
      : []),
  ];

  log(`[xreactor] launching isolated browser (engine=${resolved.engine}, profile=${profileDir})`);
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
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":10" },
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

  return { page, close };
}

export { BrowserNotFoundError as XReactorBrowserNotFoundError };

/**
 * Lightweight page-ready detection for compliance checks — fully event-driven,
 * no fixed dwell anywhere:
 *
 *   1. `waitForLoadState("load")` returns the instant the browser fires the
 *      load event (or the short cap hits) — never a fixed sleep.
 *   2. One DOM snapshot: real content present => done (typical page: 1-2s).
 *   3. Challenge interstitial: poll every 300ms and exit the MOMENT the solve
 *      clears — the wait is exactly as long as the solve takes, nothing more.
 *      Pages that simply never get content bail out at the first clear signal
 *      instead of burning a budget.
 */
export async function waitForCheckReady(
  page: Page,
  opts: { readyTimeoutMs?: number; challengeTimeoutMs?: number } = {},
): Promise<{ waitedMs: number; challengeCleared: boolean }> {
  const start = Date.now();
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8_000;
  const challengeTimeoutMs =
    opts.challengeTimeoutMs ??
    Math.max(5_000, parseInt(process.env.XREACTOR_CHALLENGE_TIMEOUT_MS || "20000", 10) || 20_000);

  // 1) Event-driven load wait: returns immediately when the page is already
  //    loaded; otherwise fires as soon as the load event happens.
  await page.waitForLoadState("load", { timeout: readyTimeoutMs }).catch(() => {});

  if (page.isClosed()) {
    return { waitedMs: Date.now() - start, challengeCleared: false };
  }

  // 2) One snapshot: real content => done. This is the happy path.
  const snap = await snapshotPage(page).catch(() => null);
  if (!snap) {
    return { waitedMs: Date.now() - start, challengeCleared: false };
  }
  if (hasRealContent(snap)) {
    return { waitedMs: Date.now() - start, challengeCleared: false };
  }

  // 3) Challenge (or still-rendering) page: poll fast and exit the moment the
  //    challenge clears. The budget only ever matters for pages that never
  //    resolve — happy pages leave on the first successful poll.
  let challengeCleared = false;
  const deadline = Date.now() + challengeTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (page.isClosed()) break;
    const poll = await snapshotPage(page).catch(() => null);
    if (!poll) break;
    if (poll.challenge) continue;
    challengeCleared = true;
    // The solve usually reloads into the real page — wait for its load event
    // (event-driven) and end immediately after.
    await page.waitForLoadState("load", { timeout: readyTimeoutMs }).catch(() => {});
    break;
  }
  return { waitedMs: Date.now() - start, challengeCleared };
}

/** Sweeps leftover xreactor profile dirs from crashed runs. */
export function sweepStaleProfiles(maxAgeMs = 60 * 60 * 1000): number {
  const tmp = os.tmpdir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("xreactor-profile-")) continue;
      const dir = path.join(tmp, name);
      try {
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if (age > maxAgeMs) {
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
