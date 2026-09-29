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
/**
 * Schemes whose "Open <handler>?" dialogs must never appear: they block the
 * single page and stall the whole check (t.me pages auto-fire tg:// on load).
 *
 * Chromium consults TWO pref stores for external protocols:
 *   - profile.default.Preferences  (protocol_handler.excluded_schemes)
 *   - profile."Secure Preferences" (protocol_handler + ExcludedSchemes)
 * Both must be seeded BEFORE first launch, and the values must be real
 * booleans — Chrome drops numeric-coerced entries silently.
 * Setting protocol_handler.allow_excluded_schemes=false + excluded entries
 * makes every prompt auto-decline with no dialog and no dwell.
 */
const SUPPRESSED_PROTOCOL_SCHEMES = [
  "tg",
  "whatsapp",
  "viber",
  "skype",
  "slack",
  "zoommtg",
  "ms-windows-store",
  "discord",
  "mailto",
  "webcal",
  "steam",
  "spotify",
];

function seedProfilePreferences(profileDir: string): void {
  try {
    // Before first launch the profile has no dirs; Chromium requires the
    // Default dir for the preference files to be honored.
    fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
    const excluded: Record<string, boolean> = {};
    for (const scheme of SUPPRESSED_PROTOCOL_SCHEMES) excluded[scheme] = true;

    const basePrefs = {
      protocol_handler: {
        allow_excluded_schemes: false,
        excluded_schemes: excluded,
      },
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      sync_promo: { show_on_first_run_allowed: false },
      distribution: { import_bookmarks: false, make_chrome_default: false },
      privacy_sandbox: { initiated: false },
    };

    fs.writeFileSync(
      path.join(profileDir, "Default", "Preferences"),
      JSON.stringify(basePrefs),
    );
    // "Secure Preferences" is tracked with HMACs for some keys, but unknown
    // / fresh-profile keys load without enforcement — the exclusion map is
    // read from it when present.
    fs.writeFileSync(
      path.join(profileDir, "Default", "Secure Preferences"),
      JSON.stringify({
        protocol_handler: {
          allow_excluded_schemes: false,
          excluded_schemes: excluded,
        },
      }),
    );
  } catch {
    // Preferences seeding is best-effort; the dialog suppression simply
    // degrades to the old behavior if the file can't be written.
  }
}

export async function launchIsolatedBrowser(
  log: (msg: string) => void,
  display?: XvfbDisplay | null,
): Promise<IsolatedBrowser> {
  const resolved = resolveBrowser(); // throws BrowserNotFoundError when missing
  const profileDir = path.join(os.tmpdir(), `xreactor-profile-${randomUUID()}`);
  await fs.promises.mkdir(profileDir, { recursive: true });
  seedProfilePreferences(profileDir);

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
 * the page is actually presentable, never later:
 *
 *   1. `waitForLoadState("load")` rides the browser's load event.
 *   2. Content-rich snapshot (>=200 chars or >=5 tracked tags) => done
 *      immediately (typical pages: 1-2s).
 *   3. SMALL pages (t.me profiles are ~45 chars) would never pass a size bar
 *      and used to burn the whole challenge ceiling — instead they finish as
 *      soon as the snapshot is STABLE: two consecutive polls with an identical
 *      title/chars/tags signature and zero challenge flags (~1.5s dwell).
 *   4. Challenge interstitials keep polling until they clear (Cloudflare
 *      solves reload the page, so "challenge flag gone" is NOT enough — we
 *      keep polling through the reload until the reloaded page is presentable).
 *      Transient null snapshots during navigation are retried, never "done".
 *
 * The ceiling (XREACTOR_CHALLENGE_TIMEOUT_MS, default 20s) is only a failure
 * bound for pages that never render; happy pages leave in 1-3 seconds.
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
  if (snap && !snap.challenge && hasRealContent(snap)) {
    return { waitedMs: Date.now() - start, challengeCleared: false, contentReady: true };
  }

  // 3) Poll: challenges wait to clear; everything else finishes as soon as
  //    the snapshot is stable (two identical polls ~600ms apart).
  let challengeCleared = false;
  let lastSignature: string | null = null;
  let stableCount = 0;
  const deadline = Date.now() + challengeTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    if (page.isClosed()) break;
    snap = await snapshotPage(page).catch(() => null);
    if (!snap) {
      // navigation in flight — retry, never treat as done
      lastSignature = null;
      stableCount = 0;
      continue;
    }
    if (snap.challenge) {
      challengeCleared = true;
      lastSignature = null;
      stableCount = 0;
      continue; // still solving
    }
    const signature = `${snap.title}|${snap.contentChars}|${snap.tagCount}|${snap.readyState}`;
    if (signature === lastSignature) {
      stableCount += 1;
      if (stableCount >= 2 && (snap.contentChars > 0 || snap.tagCount > 0)) {
        return { waitedMs: Date.now() - start, challengeCleared, contentReady: true };
      }
    } else {
      lastSignature = signature;
      stableCount = 0;
    }
  }
  return { waitedMs: Date.now() - start, challengeCleared, contentReady: false };
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
