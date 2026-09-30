import type { Page } from "patchright";
import { chromium } from "patchright";
import fs from "node:fs";
import os from "os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBrowser } from "../../utils/resolve-browser.js";
import {
  cloneDefaultProfile,
  writeExternalProtocolPrefs,
} from "../../utils/default-profile.js";
import { nodriverLaunch, nodriverClose } from "../../utils/nodriver-client.js";
import { getExtensionPaths } from "../../utils/extensions.js";
import { acquireXvfbDisplay, type XvfbDisplay } from "../xreactor/xvfb-display.js";
import { attachPageEvents } from "../../services/cdp/instrumentation/page-events.js";
import { TargetType } from "../../services/cdp/instrumentation/pw-types.js";
import type { BrowserLogger } from "../../services/cdp/instrumentation/browser-logger.js";
import type { SessionService } from "../../services/session.service.js";

/**
 * Isolated scrape browser — the xreactor pattern applied to /v1/scrape.
 *
 * TRUE CONCURRENCY, no shared state:
 * - Every scrape/screenshot/PDF job gets its OWN private nodriver-launched
 *   Chrome (nodriver picks a free CDP port per browser — no port fights).
 * - Every job runs on its OWN dedicated Xvfb display acquired through the
 *   production allocator (:11, :12, ...). The shared production display :10
 *   is NEVER touched by scrape traffic, so live sessions keep working in
 *   parallel.
 * - The profile is a fresh CLONE of the durable default profile (persistent
 *   fingerprint), or a materialized uploaded profile when profileId is given.
 *   The clone is deleted with the browser.
 * - The ffmpeg recorder films exactly this job's display, so concurrent
 *   recordings never mix browsers into one frame.
 * - Dashboard parity: the SAME instrumentation pipeline (attachPageEvents
 *   over a CDP session) records Console/Navigation/Request/Response events
 *   tagged with pageId === sessionId, and a released session row is pushed
 *   to pastSessions — identical to what the old shared-browser scrape path
 *   produced.
 */
export interface IsolatedScrapeBrowser {
  sessionId: string;
  page: Page;
  /** Dedicated display this browser runs on (null = env DISPLAY fallback). */
  display: XvfbDisplay | null;
  /**
   * Stop the recorder (if the caller started one), close the browser, free
   * the display, delete the profile clone and push the released session row.
   */
  finish: (info: {
    userAgent?: string;
    recordingFile?: string | null;
  }) => Promise<void>;
}

async function materializeUploadedProfile(
  profileId: string,
): Promise<string> {
  const { ProfileService } = await import("../../services/profile.service.js");
  const extract = (await import("extract-zip")).default;
  const meta = ProfileService.getInstance().get(profileId) as
    | { userDataDir?: string | null }
    | null;
  if (!meta?.userDataDir) {
    throw new Error(`Profile ${profileId} not found or has no userDataDir`);
  }
  const dir = path.join(os.tmpdir(), `xreactor-uploaded-${randomUUID()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await extract(meta.userDataDir, { dir });
  // Unwrap a single root folder if the archive packed one.
  try {
    const entries = await fs.promises.readdir(dir);
    if (entries.length === 1) {
      const only = path.join(dir, entries[0]);
      if ((await fs.promises.stat(only)).isDirectory()) return only;
    }
  } catch {
    // keep the extraction root
  }
  return dir;
}

function rmProfile(profileDir: string | null): void {
  if (!profileDir) return;
  fs.rm(profileDir, { recursive: true, force: true }, () => {});
}

export async function launchIsolatedScrapeBrowser(opts: {
  log: (msg: string) => void;
  sessionService: SessionService;
  instrumentationLogger: BrowserLogger;
  sessionExtensions?: string[];
  profileId?: string;
  /** Local (auth-free) proxy URL for --proxy-server. */
  proxyUrl?: string;
}): Promise<IsolatedScrapeBrowser> {
  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const logger = opts.instrumentationLogger;

  const resolved = resolveBrowser(); // throws BrowserNotFoundError when missing

  // Own screen for this job — the production allocator never hands out :10.
  const display = await acquireXvfbDisplay();

  let profileDir: string | null = null;
  try {
    profileDir = opts.profileId
      ? await materializeUploadedProfile(opts.profileId)
      : cloneDefaultProfile(opts.log);
  } catch (err) {
    display?.stop();
    throw err;
  }
  // Re-assert the protocol prefs on the working copy (idempotent) so a
  // corrupt/older clone can never resurrect the xdg-open dialog.
  if (!opts.profileId) writeExternalProtocolPrefs(profileDir, {});

  // The window fills the display so the recording frame IS the browser.
  const windowSize: [number, number] = display
    ? [display.width, display.height - 50]
    : [1920, 1080];

  opts.log(
    `[scrape] isolated browser: session=${sessionId} display=${display?.display ?? (process.env.DISPLAY || ":10")} profile=${profileDir}`,
  );

  let launch: Awaited<ReturnType<typeof nodriverLaunch>>;
  try {
    launch = await nodriverLaunch(
      {
        profile: profileDir,
        port: 0, // sidecar picks a free port (concurrency-safe)
        display: display?.display || process.env.DISPLAY || ":10",
        window: windowSize,
        executable: resolved.executablePath,
        extensions: await getExtensionPaths(opts.sessionExtensions ?? []),
        browserArgs: opts.proxyUrl ? [`--proxy-server=${opts.proxyUrl}`] : [],
        lang: "en-US",
        cfVerify: true, // always: Turnstile auto-solve, same as xreactor
      },
      90_000,
    );
  } catch (err) {
    rmProfile(profileDir);
    display?.stop();
    throw err;
  }

  if (!launch.ok || !launch.webSocketDebuggerUrl) {
    rmProfile(profileDir);
    display?.stop();
    throw new Error(launch.error || "nodriver launch failed without a CDP endpoint");
  }
  const pid = launch.pid ?? null;

  // Dashboard visibility: register the job as a LIVE session the moment its
  // private browser is up. /v1/sessions and the session view then show it
  // while it runs (the old shared-browser path had this; isolated jobs only
  // used to surface a released row after finishing).
  opts.sessionService.addRunningScrapeJob({
    id: sessionId,
    createdAt,
    cdpPort: launch.port ?? 0,
    dimensions: { width: windowSize[0], height: windowSize[1] },
    logPageId: sessionId,
  });
  opts.log(
    `[scrape] nodriver launched session=${sessionId} pid=${pid} port=${launch.port}` +
      ` extensions=${(launch.extensionsLoaded ?? []).length} loaded / ${(launch.extensionsFailed ?? []).length} failed`,
  );

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(launch.webSocketDebuggerUrl);
  } catch (err) {
    opts.sessionService.removeRunningScrapeJob(sessionId);
    if (pid != null) await nodriverClose(pid).catch(() => {});
    rmProfile(profileDir);
    display?.stop();
    throw err;
  }

  const context = browser.contexts()[0];
  if (!context) {
    opts.sessionService.removeRunningScrapeJob(sessionId);
    await browser.close().catch(() => {});
    if (pid != null) await nodriverClose(pid).catch(() => {});
    rmProfile(profileDir);
    display?.stop();
    throw new Error("nodriver browser exposed no default context over CDP");
  }

  const pages = context.pages();
  const page: Page = pages.length ? pages[0] : await context.newPage();

  // Same instrumentation the shared-browser scrape path attaches: structured
  // Console/Navigation/Request/Response events under pageId === sessionId so
  // /v1/logs/query?pageId=<sessionId> shows exactly this job's traffic.
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Runtime.enable").catch(() => {});
    await session.send("Network.enable").catch(() => {});
    await session.send("Log.enable").catch(() => {});
    (page as unknown as { __steelPageId?: string }).__steelPageId = sessionId;
    attachPageEvents(page, session, logger, TargetType.PAGE, {});
  } catch {
    // instrumentation must never break the scrape
  }

  let finished = false;
  const finish = async (info: {
    userAgent?: string;
    recordingFile?: string | null;
  }): Promise<void> => {
    if (finished) return;
    finished = true;

    // First order of business: it is no longer a live row.
    opts.sessionService.removeRunningScrapeJob(sessionId);

    try {
      await browser.close();
    } catch {
      // already dead
    }
    if (pid != null) {
      await nodriverClose(pid).catch(() => {});
    }
    // Chrome flushes profile files briefly after close; retry the removal so
    // nothing leaks into /tmp (the janitor sweep stays the last resort).
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.promises.rm(profileDir!, { recursive: true, force: true, maxRetries: 3 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    display?.stop();

    try {
      (opts.sessionService.pastSessions as unknown as Array<Record<string, unknown>>).unshift({
        id: sessionId,
        createdAt,
        status: "released",
        duration: Date.now() - new Date(createdAt).getTime(),
        eventCount: 0,
        timeout: 0,
        creditsUsed: 0,
        proxyTxBytes: 0,
        proxyRxBytes: 0,
        websocketUrl: "",
        debugUrl: "",
        debuggerUrl: "",
        sessionViewerUrl: "",
        userAgent: info.userAgent ?? "",
        proxy: "",
        dimensions: display
          ? { width: windowSize[0], height: windowSize[1] }
          : undefined,
        logPageId: sessionId,
        viewport: display
          ? { width: windowSize[0], height: windowSize[1] }
          : undefined,
        recordingFile: info.recordingFile ? `${sessionId}.mp4` : null,
      });
    } catch {
      // dashboard bookkeeping must never break the scrape
    }
  };

  return { sessionId, page, display, finish };
}
