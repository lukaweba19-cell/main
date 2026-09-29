import { randomUUID } from "node:crypto";
import type { Page } from "patchright";
import type { SessionService } from "../../services/session.service.js";
import type { CDPService } from "../../services/cdp/cdp.service.js";
import { BrowserEventType } from "../../types/index.js";
import { attachPageEvents } from "../../services/cdp/instrumentation/page-events.js";
import { TargetType } from "../../services/cdp/instrumentation/pw-types.js";
import { startSessionRecorder, type SessionRecorder } from "../../utils/scrape/page-recording.js";
import type { XvfbDisplay } from "./xvfb-display.js";

/**
 * Full-fidelity capture for isolated xreactor check browsers — IDENTICAL to
 * what a regular /v1/scrape session gets:
 *
 *   - the SAME instrumentation pipeline (attachPageEvents over a CDP session)
 *     records Console / Navigation / Request / Response / RequestFailed /
 *     PageError with the same structured shapes the dashboard expects
 *     (request.url, response.status, navigation.url, console.text, ...)
 *   - events are tagged with pageId === sessionId (via __steelPageId, the
 *     same mechanism the main browser uses), so the dashboard's
 *     /v1/logs/query?pageId=... shows ONLY this session's lines
 *   - an ffmpeg x11grab video of the check on its OWN dedicated Xvfb display
 *   - a released session row carrying the browser's REAL user agent, the
 *     viewport and logPageId — exactly like a scrape session row
 *
 * Capture failures degrade gracefully (check still completes, row shows no
 * video) — capture must never break a compliance check.
 */
export interface XReactorCapture {
  sessionId: string;
  /** Attach the SAME instrumentation the scrape pipeline uses. */
  attach: (page: Page) => Promise<void>;
  /** Begin the ffmpeg capture on the given dedicated display. */
  startRecorder: (display?: XvfbDisplay | null) => void;
  /** Stop the video recorder; finalizes the dashboard row. */
  finish: (info: {
    result: "allowed" | "disallowed";
    pagesChecked: number;
    totalMs: number;
    userAgent?: string;
  }) => Promise<void>;
}

export function startXReactorCapture(
  sessionService: SessionService,
  cdpService: CDPService,
  seedUrl: string,
): XReactorCapture {
  const sessionId = randomUUID();
  const logger = cdpService.getInstrumentationLogger();
  const createdAt = new Date().toISOString();
  let recorderPromise: Promise<SessionRecorder | null> | null = null;
  let finished = false;
  let usedDisplay: XvfbDisplay | null = null;

  const startRecorder = (display?: XvfbDisplay | null): void => {
    if (recorderPromise) return;
    usedDisplay = display ?? null;
    try {
      recorderPromise = usedDisplay
        ? startSessionRecorder(null, sessionId, {
            display: usedDisplay.display,
            width: usedDisplay.width,
            height: usedDisplay.height,
          })
        : startSessionRecorder(null, sessionId);
    } catch {
      recorderPromise = null;
    }
  };

  const attach = async (page: Page): Promise<void> => {
    // Preferred path: the exact instrumentation the main browser pipeline
    // uses (CDP Network/Runtime/Log domains => structured request/response/
    // navigation/console records). The page is tagged with __steelPageId =
    // sessionId — the same mechanism the shared browser uses — so every
    // event lands under this check's session id.
    try {
      const session = await page.context().newCDPSession(page);
      await session.send("Runtime.enable").catch(() => {});
      await session.send("Network.enable").catch(() => {});
      await session.send("Log.enable").catch(() => {});
      (page as unknown as { __steelPageId?: string }).__steelPageId = sessionId;
      attachPageEvents(page, session, logger, TargetType.PAGE, {});
      return;
    } catch {
      // fall through to the page-level fallback below
    }

    // Fallback: same structured event shapes, page-level listeners only.
    const record = (type: BrowserEventType, payload: Record<string, unknown>) => {
      try {
        logger.record({
          type,
          timestamp: new Date().toISOString(),
          pageId: sessionId,
          targetType: "page",
          ...payload,
        } as any);
      } catch {
        // logging must never break the check
      }
    };
    try {
      page.on("console", (msg) =>
        record(BrowserEventType.Console, {
          console: { level: msg.type(), text: msg.text(), loc: msg.location() },
        }),
      );
      page.on("pageerror", (err) =>
        record(BrowserEventType.PageError, { error: { message: String(err?.message || err) } }),
      );
      page.on("framenavigated", (frame) => {
        if (frame.parentFrame()) return;
        record(BrowserEventType.Navigation, { navigation: { url: frame.url() } });
      });
      page.on("request", (req) =>
        record(BrowserEventType.Request, {
          request: { method: req.method(), url: req.url(), resourceType: req.resourceType() },
        }),
      );
      page.on("response", (res) =>
        record(BrowserEventType.Response, {
          response: { status: res.status(), url: res.url() },
        }),
      );
      page.on("requestfailed", (req) =>
        record(BrowserEventType.RequestFailed, {
          error: { message: req.failure()?.errorText ?? "failed", url: req.url() },
        }),
      );
      record(BrowserEventType.Navigation, { navigation: { url: page.url() } });
    } catch {
      // capture must never break the check
    }
  };

  const finish = async (info: {
    result: "allowed" | "disallowed";
    pagesChecked: number;
    totalMs: number;
    userAgent?: string;
  }): Promise<void> => {
    if (finished) return;
    finished = true;

    let videoFile: string | null = null;
    if (recorderPromise) {
      try {
        const recorder = await recorderPromise;
        if (recorder) videoFile = await recorder.stop();
      } catch {
        videoFile = null;
      }
    }

    try {
      (sessionService.pastSessions as unknown as Array<Record<string, unknown>>).unshift({
        id: sessionId,
        createdAt,
        status: "released",
        duration: info.totalMs,
        eventCount: info.pagesChecked,
        timeout: 0,
        creditsUsed: 0,
        proxyTxBytes: 0,
        proxyRxBytes: 0,
        websocketUrl: "",
        debugUrl: "",
        debuggerUrl: "",
        sessionViewerUrl: "",
        // The browser's REAL user agent — same field a scrape session row
        // fills. The verdict lives in the API response, not here.
        userAgent: info.userAgent ?? "",
        proxy: "",
        dimensions: usedDisplay ? { width: 1440, height: 900 } : undefined,
        logPageId: sessionId,
        viewport: { width: 1440, height: 900 },
        recordingFile: videoFile ? `${sessionId}.mp4` : null,
      });
    } catch {
      // dashboard bookkeeping must never break the check
    }
  };

  return { sessionId, attach, startRecorder, finish };
}
