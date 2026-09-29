import { randomUUID } from "node:crypto";
import type { SessionService } from "../../services/session.service.js";

/**
 * Surfaces xreactor checks in the sessions dashboard.
 *
 * xreactor runs on isolated throwaway browsers (no Steel session, no
 * recording), but users expect to SEE each check in the UI. This records a
 * lightweight released-session entry per check — no video, no live session,
 * nothing but the dashboard row — which the daily flush clears like any
 * other history.
 */
export function recordXReactorSession(
  sessionService: SessionService,
  info: {
    seedUrl: string;
    result: "allowed" | "disallowed";
    pagesChecked: number;
    totalMs: number;
  },
): void {
  try {
    const now = new Date().toISOString();
    const id = randomUUID();
    // Shape matches the SessionDetails schema; extra fields (xreactor*) are
    // additive and simply render where the UI shows generic details.
    (sessionService.pastSessions as unknown as Array<Record<string, unknown>>).unshift({
      id,
      createdAt: now,
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
      userAgent: "XReactor compliance check",
      proxy: "",
      xreactor: {
        seedUrl: info.seedUrl,
        result: info.result,
        pagesChecked: info.pagesChecked,
      },
    });
  } catch {
    // Dashboard bookkeeping must never break the check itself.
  }
}
