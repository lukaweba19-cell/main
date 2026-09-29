import { randomUUID } from "node:crypto";
import type { Page } from "patchright";
import type { SessionService } from "../../services/session.service.js";
import type { CDPService } from "../../services/cdp/cdp.service.js";
import { BrowserEventType } from "../../types/index.js";
import { startSessionRecorder, type SessionRecorder } from "../../utils/scrape/page-recording.js";

/**
 * Full-fidelity capture for isolated xreactor check browsers — the same
 * treatment a regular scrape session gets:
 *
 *   - an ffmpeg x11grab video of the whole check (same recorder /v1/scrape
 *     uses; the isolated browser is headful on the same Xvfb display)
 *   - Console / Navigation / Request / Response / RequestFailed / PageError
 *     events recorded into the shared instrumentation log storage under the
 *     check's session id, so the dashboard Console/Network tabs work
 *   - a released session row so the check appears in the sessions list with
 *     its verdict and the recording attached
 *
 * Capture failures degrade gracefully (check still completes, row shows no
 * video) — capture must never break a compliance check.
 */
export interface XReactorCapture {
  sessionId: string;
  /** Attach event listeners to the crawl page (call once, before navigating). */
  attach: (page: Page) => void;
  /** Stop the video recorder; finalizes the dashboard row. */
  finish: (info: { result: "allowed" | "disallowed"; pagesChecked: number; totalMs: number }) => Promise<void>;
}

export function startXReactorCapture(
  sessionService: SessionService,
  cdpService: CDPService,
  seedUrl: string,
): XReactorCapture {
  const sessionId = randomUUID();
  const pageId = randomUUID();
  const logger = cdpService.getInstrumentationLogger();
  const createdAt = new Date().toISOString();
  let recorderPromise: Promise<SessionRecorder | null> | null = null;
  let finished = false;
  let durationMs = 0;

  const record = (type: BrowserEventType, data: Record<string, unknown>) => {
    try {
      logger.record({
        type,
        timestamp: new Date().toISOString(),
        pageId,
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
      });
    } catch {
      // dashboard bookkeeping must never break the check
    }
  };

  // Start the recorder immediately: the isolated browser will appear on the
  // same Xvfb display moments later, and x11grab records whatever shows up.
  try {
    recorderPromise = startSessionRecorder(null, sessionId);
  } catch {
    recorderPromise = null;
  }

  return { sessionId, attach, finish };
}
