import type { Page } from "patchright";
import { chromium } from "patchright";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserNotFoundError, resolveBrowser } from "../../utils/resolve-browser.js";
import {
  cloneDefaultProfile,
  writeExternalProtocolPrefs,
} from "../../utils/default-profile.js";
import { nodriverLaunch, nodriverClose } from "../../utils/nodriver-client.js";
import { getExtensionPaths } from "../../utils/extensions.js";
import {
  snapshotPage,
  hasRealContent,
} from "../../utils/scrape/content-ready.js";
import { ScrapePool } from "../../utils/scrape/scrape-pool.js";
import { installReadinessPredicate } from "../../utils/scrape/content-ready.js";
import { acquireXvfbDisplay, type XvfbDisplay } from "./xvfb-display.js";

/**
 * XReactor runs COMPLETELY outside the Steel session system: every checked
 * URL gets its own private nodriver-launched Chrome process, closed and its
 * profile clone deleted afterwards.
 *
 * FINGERPRINT PERSISTENCE (the core of this migration):
 * - Every check starts from a CLONE of the durable default profile
 *   (/data/steel-profiles/default). The clone carries the same fonts, prefs,
 *   cookies and metrics every time, so every check presents the SAME
 *   fingerprint and the "never ask about external protocols" preference
 *   seeded into the default profile always applies.
 * - No per-launch random seeds exist anywhere any more.
 *
 * TRUE CONCURRENCY with per-check recordings (unchanged):
 * - Each check acquires its OWN Xvfb display (:11, :12, ...) and launches its
 *   browser there, so concurrent checks never share a screen and each video
 *   films exactly one browser.
 * - The shared Steel display (:10) is never touched, so /v1/scrape keeps
 *   working in parallel with xreactor traffic.
 * - The browser window fills the display so the recording frame is exactly
 *   the browser.
 *
 * PROFILES: every check always runs on the durable default profile — the
 * single persistent fingerprint. Callers cannot swap it (that would let a
 * client escape the seeded external-protocol prefs).

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
 * Launches a private nodriver Chrome for one check.
 *
 * - Profile = clone of the durable default profile => persistent fingerprint
 *   + persistent "no external protocol popups" prefs on every single check.
 *   Non-negotiable: callers cannot substitute another profile.
 * - Extensions load through nodriver's own extension API (branded Chrome
 *   >= 137 ignores --load-extension; nodriver injects the feature flags that
 *   re-enable command-line extension loading).
 * - nodriver-cf-verify ALWAYS runs on the seed tab (Turnstile auto-solve) —
 *   not configurable.
 * - When `display` is provided the browser runs on that dedicated Xvfb
 *   screen; otherwise it falls back to the shared DISPLAY.
 */
export async function launchIsolatedBrowser(
  log: (msg: string) => void,
  display?: XvfbDisplay | null,
): Promise<IsolatedBrowser> {
  const resolved = resolveBrowser(); // throws BrowserNotFoundError when missing

  // Profile: ALWAYS a fresh clone of the durable default profile.
  const profileDir = cloneDefaultProfile(log);
  // Re-assert the protocol prefs on the working copy (idempotent merge) so a
  // corrupt/older profile can never resurrect the xdg-open dialog.
  writeExternalProtocolPrefs(profileDir, {});

  const extensionPaths = await getExtensionPaths();
  const width = display?.width ?? 1440;
  const height = (display?.height ?? 900) - 50; // room for window decorations

  log(
    `[xreactor] launching isolated nodriver browser (profile=${profileDir}, display=${display?.display ?? (process.env.DISPLAY || ":10")})`,
  );

  let launch: Awaited<ReturnType<typeof nodriverLaunch>>;
  try {
    launch = await nodriverLaunch({
      profile: profileDir,
      port: 0, // sidecar picks a free port (concurrency-safe)
      display: display?.display || process.env.DISPLAY || ":10",
      window: [width, height],
      executable: resolved.executablePath,
      extensions: extensionPaths,
      cfVerify: true, // always: Turnstile auto-solve on the seed tab
    }, 90_000);
  } catch (err) {
    fs.rm(profileDir, { recursive: true, force: true }, () => {});
    throw err;
  }

  if (!launch.ok || !launch.webSocketDebuggerUrl) {
    fs.rm(profileDir, { recursive: true, force: true }, () => {});
    throw new Error(launch.error || "nodriver launch failed without a CDP endpoint");
  }
  const pid = launch.pid ?? null;
  log(
    `[xreactor] nodriver launched chrome pid=${pid} port=${launch.port}` +
      ` extensions=${(launch.extensionsLoaded ?? []).length} loaded / ${(launch.extensionsFailed ?? []).length} failed`,
  );
  if (launch.extensionsFailed?.length) {
    log(`[xreactor] extension load failures: ${JSON.stringify(launch.extensionsFailed)}`);
  }

  // Attach Node to the nodriver-owned browser over CDP.
  const browser = await chromium.connectOverCDP(launch.webSocketDebuggerUrl);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    if (pid != null) await nodriverClose(pid);
    fs.rm(profileDir, { recursive: true, force: true }, () => {});
    throw new Error("nodriver browser exposed no default context over CDP");
  }

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  const close = async (): Promise<void> => {
    try {
      await browser.close();
    } catch {
      // already dead
    }
    if (pid != null) {
      await nodriverClose(pid).catch(() => {});
    }
    // Chrome keeps flushing profile files for a moment after close; retry the
    // removal briefly so nothing leaks into /tmp (the maintenance sweep stays
    // as the last-resort janitor for crashed runs).
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.promises.rm(profileDir!, { recursive: true, force: true, maxRetries: 3 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };

  return { page, display: display ?? null, close };
}

export { BrowserNotFoundError as XReactorBrowserNotFoundError };

/**
 * Page-ready detection for compliance checks — FULLY EVENT-DRIVEN, zero
 * fixed waits:
 *
 * The same in-page readiness predicate the scrape path uses runs inside the
 * check browser and resolves the instant the page is presentable (not a
 * challenge, content rendered, DOM stable across one frame). A normal page
 * resolves ~100-500ms after its content exists; a challenge resolves the
 * moment it clears — 2s or 2min, never an artificial window.
 *
 * `challengeTimeoutMs` is ONLY a failure ceiling for pages that never render
 * (dead tab, unsolvable challenge) — the normal path never reaches it.
 */
export async function waitForCheckReady(
  page: Page,
  opts: { challengeTimeoutMs?: number } = {},
): Promise<{ waitedMs: number; challengeCleared: boolean; contentReady: boolean }> {
  const start = Date.now();
  const challengeTimeoutMs =
    opts.challengeTimeoutMs ??
    Math.max(5_000, parseInt(process.env.XREACTOR_CHALLENGE_TIMEOUT_MS || "45000", 10) || 45_000);

  let challengeSeen = false;

  while (Date.now() - start < challengeTimeoutMs) {
    if (page.isClosed()) {
      return { waitedMs: Date.now() - start, challengeCleared: false, contentReady: false };
    }

    let fired: any = null;
    try {
      fired = await Promise.race([
        page.evaluate(installReadinessPredicate).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 5_000)),
      ]);
    } catch {
      fired = null;
    }

    if (fired && fired.presentable) {
      return { waitedMs: Date.now() - start, challengeCleared: challengeSeen, contentReady: true };
    }
    if (fired && fired.challenge) {
      challengeSeen = true;
    }

    // Predicate stays installed in-page (rAF loop); brief re-poll picks up
    // its resolution or a navigation without adding any dwell.
    await new Promise((r) => setTimeout(r, 150));
  }
  return { waitedMs: Date.now() - start, challengeCleared: challengeSeen, contentReady: false };
}

/**
 * Sweeps leftover xreactor profile dirs from crashed runs.
 * maxAgeMs <= 0 removes every leftover regardless of age (daily flush).
 */
export function sweepStaleProfiles(maxAgeMs = 60 * 60 * 1000): number {
  const tmp = "/tmp";
  let removed = 0;
  const prefixes = ["xreactor-profile-", "xreactor-uploaded-"];
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!prefixes.some((p) => name.startsWith(p))) continue;
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
