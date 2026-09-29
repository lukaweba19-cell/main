import { randomUUID } from "node:crypto";
import type { Page } from "patchright";
import type { SessionService } from "../../services/session.service.js";
import type { CDPService } from "../../services/cdp/cdp.service.js";
import { BrowserEventType } from "../../types/index.js";
import { startSessionRecorder, type SessionRecorder } from "../../utils/scrape/page-recording.js";
import type { XvfbDisplay } from "./xvfb-display.js";

/**
 * Full-fidelity capture for isolated xreactor check browsers — the same
 * treatment a regular scrape session gets:
 *
 *   - an ffmpeg x11grab video of the check on its OWN dedicated Xvfb display
 *     (concurrent checks each film exactly their own browser — the frame IS
 *     the browser window, no black bars, no other checks on screen)
 *   - Console / Navigation / Request / Response / RequestFailed / PageError
 *     events recorded into the shared instrumentation log storage with
 *     pageId === sessionId. The dashboard passes that id back to
 *     /v1/logs/query?pageId=... so the Console/Network tabs show ONLY this
 *     session's events, even when many checks run at once.
 *   - a released session row (with logPageId + viewport) so the check appears
 *     in the sessions list with its verdict and the recording attached
 *
 * Capture failures degrade gracefully (check still completes, row shows no
 * video) — capture must never break a compliance check.
 */
export interface XReactorCapture {
  sessionId: string;
  /** Attach event listeners to the crawl page (call once, before navigating). */
  attach: (page: Page) => void;
  /** Begin the ffmpeg capture on this check's dedicated display. */
  startRecorder: () => void;
  /** Stop the video recorder; finalizes the dashboard row. */
  finish: (info: { result: "allowed" | "disallowed"; pagesChecked: number; totalMs: number }) => Promise<void>;
}

export function startXReactorCapture(
  sessionService: SessionService,
  cdpService: CDPService,
  seedUrl: string,
  display?: XvfbDisplay | null,
): XReactorCapture {
  const sessionId = randomUUID();
  const logger = cdpService.getInstrumentationLogger();
  const createdAt = new Date().toISOString();
  let recorderPromise: Promise<SessionRecorder | null> | null = null;
  let finished = false;
  let durationMs = 0;

  // Events are tagged with the session id itself — the UI queries logs with
  // pageId=sessionId, so concurrent sessions can never see each other's lines.
  const record = (type: BrowserEventType, data: Record<string, unknown>) => {
    try {
      logger.record({
        type,
        timestamp: new Date().toISOString(),
        pageId: sessionId,
        targetType: "page",
        data,
      } as any);
    } catch {
      // logging must never break the check
    }
  };

  const attach = (page: Page): void => {
    page.on("console", (msg) =>
      record(BrowserEventType.Console, {
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        page: { url: page.url() },
      }),
    );
    page.on("pageerror", (err) =>
      record(BrowserEventType.PageError, {
        message: String(err?.message || err),
        page: { url: page.url() },
      }),
    );
    page.on("framenavigated", (frame) => {
      if (frame.parentFrame()) return;
      record(BrowserEventType.Navigation, {
        url: frame.url(),
        page: { url: frame.url() },
      });
    });
    page.on("request", (req) =>
      record(BrowserEventType.Request, {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        page: { url: page.url() },
      }),
    );
    page.on("response", (res) =>
      record(BrowserEventType.Response, {
        url: res.url(),
        status: res.status(),
        page: { url: page.url() },
      }),
    );
    page.on("requestfailed", (req) =>
      record(BrowserEventType.RequestFailed, {
        url: req.url(),
        failure: req.failure()?.errorText ?? "failed",
        page: { url: page.url() },
      }),
    );
  };

  const finish = async (info: {
    result: "allowed" | "disallowed";
    pagesChecked: number;
    totalMs: number;
  }): Promise<void> => {
    if (finished) return;
    finished = true;
    durationMs = info.totalMs;

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
        userAgent: `XReactor: ${info.result.toUpperCase()} — ${seedUrl}`,
        proxy: "",
        // Dashboard wiring: video panel + per-session log filtering.
        dimensions: display
          ? { width: 1440, height: 900 }
          : undefined,
        logPageId: sessionId,
        viewport: { width: 1440, height: 900 },
        recordingFile: videoFile ? `${sessionId}.mp4` : null,
      });
    } catch {
      // dashboard bookkeeping must never break the check
    }
  };

  // Start the recorder on THIS check's dedicated display (falls back to the
  // shared :10 display when Xvfb is unavailable). Started lazily from the
  // controller right after the display is acquired.
  const startRecorder = (): void => {
    if (recorderPromise) return;
    try {
      recorderPromise = display
        ? startSessionRecorder(null, sessionId, { display: display.display, width: display.width, height: display.height })
        : startSessionRecorder(null, sessionId);
    } catch {
      recorderPromise = null;
    }
  };

  return { sessionId, attach, finish, startRecorder };
}
