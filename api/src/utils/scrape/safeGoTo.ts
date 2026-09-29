import { Page, Request, Response as HTTPResponse } from "patchright";

export interface SafeGotoResult {
  response: HTTPResponse | null;
  isPdf: boolean;
  pdfResponse: HTTPResponse | null;
  /** True when an external-protocol redirect (tg://, whatsapp://, ...) aborted the navigation. */
  externalProtocol?: boolean;
}

/**
 * Navigates to a URL and tolerates the two main-frame abort cases Chromium
 * produces instead of a normal load:
 *
 * 1. PDFs: the main-frame response is application/pdf and Chromium aborts the
 *    navigation to hand it to the viewer.
 * 2. External-protocol redirects (tg://resolve, whatsapp://, mailto:, ...):
 *    a page's meta-refresh/JS hands the navigation to an external handler;
 *    Chromium aborts the request and page.goto can hang until its timeout
 *    because the awaited lifecycle event never fires.
 *
 * Returns { response, isPdf, pdfResponse, externalProtocol }.
 *
 * - response: the normal Response from page.goto (null if it aborted)
 * - isPdf: boolean indicating if the main-frame response was a PDF
 * - pdfResponse: the Response for the PDF (so you can buffer() it, if desired)
 */
export async function safeGoto(
  page: Page,
  url: string,
  options: { timeout?: number; waitUntil?: string } & Record<string, unknown> = {},
): Promise<SafeGotoResult> {
  let pdfResponse: HTTPResponse | null = null;
  let externalProtocolAbort = false;

  const onResponse = (res: HTTPResponse) => {
    // Only consider main-frame document navigations
    const req = res.request();
    const isMainFrameDoc = req.resourceType() === "document" && req.frame() === page.mainFrame();

    if (!isMainFrameDoc) return;

    const ct = (res.headers()["content-type"] || "").toLowerCase();
    if (ct.includes("application/pdf")) {
      pdfResponse = res;
    }
  };

  const onRequestFailed = (req: Request) => {
    const isMainFrameDoc = req.resourceType() === "document" && req.frame() === page.mainFrame();
    if (!isMainFrameDoc) return;
    const failure = req.failure()?.errorText || "";
    if (!failure.includes("ERR_ABORTED")) return;
    const scheme = (req.url().split(":")[0] || "").toLowerCase();
    if (scheme && scheme !== "http" && scheme !== "https") {
      // External-protocol navigation (tg://, whatsapp://, ...) — Chromium
      // aborts it and the goto lifecycle never completes.
      externalProtocolAbort = true;
    }
  };

  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  const gotoTimeoutMs = Number(options.timeout) > 0 ? Number(options.timeout) : 45_000;

  try {
    const gotoPromise = page.goto(url, options as never);

    // Race the goto against an external-protocol abort: in that case goto may
    // never settle, and waiting for it would just burn the full timeout.
    const raced = await Promise.race([
      gotoPromise.then(
        (resp) => ({ kind: "goto" as const, resp }),
        (err) => ({ kind: "error" as const, err }),
      ),
      new Promise<{ kind: "external" }>((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (externalProtocolAbort) {
            clearInterval(timer);
            resolve({ kind: "external" });
          } else if (Date.now() - started > gotoTimeoutMs + 5_000) {
            clearInterval(timer);
          }
        }, 100);
      }),
    ]);

    if (raced.kind === "external") {
      // Swallow the eventual goto rejection; the page stays usable for
      // content extraction (the original document is still rendered).
      gotoPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
      return { response: null, isPdf: false, pdfResponse: null, externalProtocol: true };
    }

    if (raced.kind === "error") {
      const message = String((raced.err && (raced.err as Error).message) || "");
      // If we detected a PDF and Chromium aborted the navigation, swallow it
      if (pdfResponse && message.includes("net::ERR_ABORTED")) {
        return { response: null, isPdf: true, pdfResponse };
      }
      throw raced.err;
    }

    return { response: raced.resp ?? null, isPdf: !!pdfResponse, pdfResponse };
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
}
