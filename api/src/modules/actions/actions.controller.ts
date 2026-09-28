import { FastifyReply } from "fastify";
import { Page } from "patchright";
import { CDPService } from "../../services/cdp/cdp.service.js";
import { ShutdownReason } from "../../services/cdp/plugins/core/base-plugin.js";
import { SessionService } from "../../services/session.service.js";
import { ScrapeFormat } from "../../types/index.js";
import { getErrors } from "../../utils/errors.js";
import { updateLog } from "../../utils/logging.js";
import { IProxyServer } from "../../utils/proxy.js";
import {
  cleanHtml,
  getDefuddleContent,
  isJsonContentType,
  jsonToMarkdown,
  stripBase64Images,
} from "../../utils/scrape/index.js";
import { normalizeUrl } from "../../utils/url.js";
import { PDFRequest, ScrapeRequest, ScreenshotRequest, SearchRequest } from "./actions.schema.js";
import { DefuddleResponse } from "defuddle";
import { buildHtmlLikeMetadataFromPdf, convertPdfWithMupdf } from "../../utils/scrape/pdfToHtml.js";
import { safeGoto } from "../../utils/scrape/safeGoTo.js";
import {
  waitForPageContent,
  type WaitForContentResult,
} from "../../utils/scrape/content-ready.js";
import { scrapePool } from "../../utils/scrape/scrape-pool.js";

/**
 * Every action funnels through one lifecycle:
 *   ensureBrowser (headful patchright, all extensions auto-loaded)
 *   -> promote to a live session (starts the recording)
 *   -> do the work on the primary page
 *   -> release the session (stops + flushes the recording)
 */
async function withScraperSession<T>(
  sessionService: SessionService,
  browserService: CDPService,
  log: (msg: string) => void,
  opts: { proxyUrl?: string | null; sessionExtensions?: string[] },
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  return scrapePool.run(async () => {
    let proxy: IProxyServer | null = null;

    try {
      if (opts.proxyUrl) {
        proxy = await sessionService.proxyFactory(opts.proxyUrl);
        await proxy.listen();
      }

      // Fresh headful Chrome per job. startSession owns the full launch
      // (config, timezone, extensions); a second ensureBrowser here would
      // take the reuse path and close/recreate pages on a freshly launched
      // browser, which can kill a --no-zygote renderer.
      const session = await sessionService.startSession({
        proxyUrl: proxy?.url ?? undefined,
        sessionExtensions: opts.sessionExtensions,
      });

      const page = await browserService.getPrimaryPage();
      const result = await fn(page);

      // Release marks status=released with the real elapsed duration and
      // flushes this session's video recording.
      const released = await sessionService.endSession({ relaunchIdle: false });
      log(`[scrape] session ${released.id} released after ${released.duration}ms`);

      return result;
    } finally {
      if (proxy) {
        await proxy.close(true).catch(() => {});
      }
      // Belt-and-braces: if startSession threw, make sure nothing is left over.
      // endSession is guarded so concurrent lifecycles never double-release;
      // a full browser shutdown is only forced if ending the session fails.
      try {
        if (sessionService.activeSession.status === "live") {
          await sessionService.endSession({ relaunchIdle: false });
        }
      } catch {
        await browserService.shutdown(ShutdownReason.SESSION_END).catch(() => {});
      }
    }
  });
}

async function startRecording(
  sessionService: SessionService,
  request: { log: { warn: (obj: any, msg: string) => void } },
): Promise<void> {
  try {
    const { startSessionRecorder } = await import("../../utils/scrape/page-recording.js");
    const sid = sessionService.activeSession?.id;
    if (sid) {
      const recorder = await startSessionRecorder(null, sid);
      if (recorder) {
        (sessionService.activeSession as any).__recorder = recorder;
      }
    }
  } catch (err) {
    request.log.warn({ err }, "startSessionRecorder failed");
  }
}

async function stopRecording(sessionService: SessionService): Promise<void> {
  try {
    const recorder = (sessionService.activeSession as any).__recorder;
    if (recorder) {
      (sessionService.activeSession as any).__recorder = null;
      await recorder.stop();
    }
  } catch {}
}

export const handleScrape = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: ScrapeRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { url, format, screenshot, pdf, proxyUrl, logUrl, removeBase64Images } = request.body;

  try {
    const response = await withScraperSession(
      sessionService,
      browserService,
      (msg) => request.log.info(msg),
      { proxyUrl },
      async (page) => {
        await startRecording(sessionService, request as any);

        let normalizedUrl: string | null = null;
        if (url) {
          normalizedUrl = normalizeUrl(url);
          if (!normalizedUrl) {
            throw new Error(`Invalid URL: ${url}`);
          }
        }

        const navStart = Date.now();
        const safeResponse = normalizedUrl
          ? await safeGoto(page, normalizedUrl, {
              timeout: 45000,
              waitUntil: "domcontentloaded",
            })
          : { response: null, isPdf: false, pdfResponse: null };
        times.pageLoadTime = Date.now() - navStart;

        const response0 = safeResponse.response ?? safeResponse.pdfResponse;
        const isPdf = safeResponse.isPdf;
        const contentType = response0?.headers()["content-type"]?.toLowerCase() || "";
        const isJson = isJsonContentType(contentType);

        // Automatic content-ready wait: challenges are detected and waited out
        // (solved by the loaded extensions), and we finish the moment real
        // content is parseable — no user-configured millisecond delay.
        let content: WaitForContentResult = {
          ready: true,
          challengeDetected: false,
          challengeCleared: false,
          waitedMs: 0,
          snapshot: null,
        };
        if (!isPdf && !isJson) {
          const contentStart = Date.now();
          content = await waitForPageContent(page, {
            timeoutMs: 60_000,
            pollMs: 750,
            log: (msg) => request.log.info(msg),
          });
          times.contentReadyWaitMs = content.waitedMs;
        }
        times.challengeDetected = content.challengeDetected ? 1 : 0;
        times.challengeCleared = content.challengeCleared ? 1 : 0;

        let scrapeResponse: Record<string, any> = {};
        let htmlContent = "";
        let cleanedHtml: string;
        let readabilityContent: DefuddleResponse;

        if (isPdf || contentType.includes("application/pdf")) {
          // Node fetch using session cookies (same browser auth state)
          const targetUrl = normalizedUrl || url!;
          const cookies = await page.context().cookies(targetUrl);
          const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
          const fetchHeaders: Record<string, string> = {};
          if (cookieHeader) fetchHeaders["Cookie"] = cookieHeader;
          if (!fetchHeaders["Referer"]) {
            const u = new URL(targetUrl);
            fetchHeaders["Referer"] = u.origin + "/";
          }
          const nodeRes = await fetch(targetUrl, {
            method: "GET",
            redirect: "follow",
            headers: fetchHeaders,
          });
          const nodeCT = (nodeRes.headers.get("content-type") || "").toLowerCase();
          if (!nodeRes.ok || !nodeCT.includes("application/pdf")) {
            throw new Error(`Expected PDF; got status ${nodeRes.status} content-type ${nodeCT}`);
          }
          const arrBuf = await nodeRes.arrayBuffer();
          const pdfBuffer = Buffer.from(arrBuf);

          const convertStart = Date.now();
          const { html, links, meta } = convertPdfWithMupdf(pdfBuffer);
          htmlContent = html;
          times.pdfHtmlConvertTime = Date.now() - convertStart;

          const htmlMeta = buildHtmlLikeMetadataFromPdf(meta, {
            urlSource: targetUrl,
            statusCode: nodeRes.status,
            htmlForFallback: htmlContent,
          });

          scrapeResponse = {
            content: {},
            metadata: {
              ...htmlMeta,
              statusCode: nodeRes.status,
              headers: Object.fromEntries(nodeRes.headers.entries()),
              originalContentType: nodeCT,
              pdfAcquisition: "node-fetch-with-cookies",
            },
            links,
          };

          if (pdf) {
            scrapeResponse.pdf = pdfBuffer.toString("base64");
          }
        } else if (isJson) {
          let rawJson = "";
          try {
            rawJson = (await response0?.text()) ?? "";
          } catch {
            rawJson = "";
          }
          htmlContent = rawJson;

          const [base64Screenshot, pdfBuffer] = await Promise.all([
            screenshot
              ? page.screenshot({ type: "jpeg", quality: 100 } as any).then((b) => b.toString("base64"))
              : null,
            pdf ? page.pdf().then((b) => b.toString("base64")) : null,
          ]);

          scrapeResponse = {
            content: {},
            metadata: {
              urlSource: normalizedUrl || url,
              timestamp: new Date().toISOString(),
              originalContentType: contentType,
              statusCode: response0?.status() ?? 200,
            },
            links: [],
          };

          if (base64Screenshot) {
            scrapeResponse.screenshot = base64Screenshot;
          }
          if (pdfBuffer) {
            scrapeResponse.pdf = pdfBuffer;
          }
        } else {
          // Regular HTML flow
          const [extracted, base64Screenshot, pdfBuffer] = await Promise.all([
            page.evaluate(() => {
              const getMetaContent = (selector: string) => {
                const element = document.querySelector(selector);
                return element ? element.getAttribute("content") : null;
              };
              const getMetaByName = (name: string) => getMetaContent(`meta[name="${name}"]`);
              const getMetaByProperty = (property: string) =>
                getMetaContent(`meta[property="${property}"]`);

              const extractJsonLd = () => {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                const jsonLdData: any[] = [];
                scripts.forEach((script) => {
                  try {
                    const data = JSON.parse(script.textContent || "");
                    jsonLdData.push(data);
                  } catch (e) {
                    console.error(e);
                  }
                });
                return jsonLdData;
              };

              return {
                html: document.documentElement.outerHTML,
                links: [...document.links].map((l) => ({
                  url: l.href,
                  text: l.textContent?.trim() || "",
                })),
                metadata: {
                  title: document.title,
                  language: document.documentElement.lang,
                  urlSource: window.location.href,
                  timestamp: new Date().toISOString(),

                  description: getMetaByName("description"),
                  keywords: getMetaByName("keywords"),
                  author: getMetaByName("author"),

                  ogTitle: getMetaByProperty("og:title"),
                  ogDescription: getMetaByProperty("og:description"),
                  ogImage: getMetaByProperty("og:image"),
                  ogUrl: getMetaByProperty("og:url"),
                  ogSiteName: getMetaByProperty("og:site_name"),

                  articleAuthor: getMetaByProperty("article:author"),
                  publishedTime: getMetaByProperty("article:published_time"),
                  modifiedTime: getMetaByProperty("article:modified_time"),

                  canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
                  favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href"),

                  jsonLd: extractJsonLd(),
                  statusCode: 200,
                },
              };
            }),
            screenshot
              ? page.screenshot({ type: "jpeg", quality: 100 } as any).then((b) => b.toString("base64"))
              : null,
            pdf ? page.pdf().then((b) => b.toString("base64")) : null,
          ]);

          htmlContent = extracted.html;
          times.extractionTime = Date.now() - startTime;

          scrapeResponse = { content: {}, metadata: extracted.metadata, links: extracted.links };

          if (base64Screenshot) {
            scrapeResponse.screenshot = base64Screenshot;
          }
          if (pdfBuffer) {
            scrapeResponse.pdf = pdfBuffer;
          }
        }

        // Format handling (works for both PDF converted HTML and normal HTML)
        if (format && format.length > 0) {
          if (format.includes(ScrapeFormat.HTML)) {
            scrapeResponse.content.html = htmlContent;
          }

          const needsCleanedHtml = format.includes(ScrapeFormat.CLEANED_HTML);
          const needsReadability =
            format.includes(ScrapeFormat.READABILITY) || format.includes(ScrapeFormat.MARKDOWN);

          if (needsCleanedHtml && !isJson) {
            const cleanHtmlStart = Date.now();
            cleanedHtml = cleanHtml(htmlContent);
            times.cleanedHtmlTime = Date.now() - cleanHtmlStart;

            if (format.includes(ScrapeFormat.CLEANED_HTML)) {
              scrapeResponse.content.cleaned_html = cleanedHtml;
            }
          }

          if (needsReadability && !isJson) {
            const readabilityStart = Date.now();
            readabilityContent = await getDefuddleContent(htmlContent, normalizedUrl || url);
            times.readabilityTime = Date.now() - readabilityStart;

            scrapeResponse.metadata.author =
              scrapeResponse.metadata.author || readabilityContent.author || null;
            scrapeResponse.metadata.publishedTime =
              scrapeResponse.metadata.publishedTime || readabilityContent.published || null;
            scrapeResponse.metadata.wordCount = readabilityContent.wordCount;

            if (format.includes(ScrapeFormat.READABILITY)) {
              scrapeResponse.content.readability = readabilityContent.content;
            }
          }

          if (format.includes(ScrapeFormat.MARKDOWN)) {
            const markdownStart = Date.now();
            if (isJson) {
              scrapeResponse.content.markdown = jsonToMarkdown(htmlContent);
            } else {
              let markdown = readabilityContent!.contentMarkdown ?? "";
              if (removeBase64Images) {
                markdown = stripBase64Images(markdown);
              }
              scrapeResponse.content.markdown = markdown;
            }
            times.markdownTime = Date.now() - markdownStart;
          }
        } else {
          scrapeResponse.content.html = htmlContent;
        }

        await stopRecording(sessionService);
        times.totalInstanceTime = Date.now() - startTime;

        return scrapeResponse;
      },
    );

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send(response);
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    return reply.code(500).send({ message: error });
  }
};

export const handleSearch = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: SearchRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { query, proxyUrl, logUrl } = request.body;

  try {
    const results = await withScraperSession(
      sessionService,
      browserService,
      (msg) => request.log.info(msg),
      { proxyUrl },
      async (page) => {
        // Go to Brave
        await page.goto(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, {
          waitUntil: "domcontentloaded",
        });

        await page.waitForSelector("#results", { timeout: 15000 }).catch(() => {});

        // Scrape results
        const results = await page.evaluate(() => {
          const items = document.querySelectorAll("div.snippet");

          return Array.from(items)
            .map((item) => {
              if (
                [
                  "llm-snippet",
                  "faq",
                  "pagination-snippet",
                  "search-elsewhere",
                  "infoblox-snippet",
                  "discussions",
                ].includes(item.id)
              ) {
                return;
              }
              const urlEl = item.querySelector("div.result-content a");
              const descEl = item.querySelector("div.generic-snippet");
              const titleEl = item.querySelector("div.result-content a div.title");

              return {
                title: titleEl?.textContent?.trim() || null,
                url: urlEl?.getAttribute("href") || null,
                description: descEl?.textContent?.split("-")[1]?.trim() || null,
              };
            })
            .filter(
              (item) =>
                item &&
                typeof item === "object" &&
                "title" in item &&
                "url" in item &&
                "description" in item &&
                item.title !== null &&
                item.url !== null,
            );
        });
        times.totalInstanceTime = Date.now() - startTime;
        return results;
      },
    );

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send({ results });
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    return reply.code(500).send({ message: error });
  }
};

export const handleScreenshot = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: ScreenshotRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { url, logUrl, proxyUrl, fullPage } = request.body;

  try {
    const screenshot = await withScraperSession(
      sessionService,
      browserService,
      (msg) => request.log.info(msg),
      { proxyUrl },
      async (page) => {
        await startRecording(sessionService, request as any);

        if (url) {
          const normalizedUrl = normalizeUrl(url);
          if (!normalizedUrl) {
            throw new Error(`Invalid URL: ${url}`);
          }
          await page.goto(normalizedUrl, { timeout: 45000, waitUntil: "domcontentloaded" });
          // Automatic readiness — no fixed delay.
          const content = await waitForPageContent(page, { timeoutMs: 30_000, pollMs: 750 });
          times.contentReadyWaitMs = content.waitedMs;
        }

        const screenshot = await page.screenshot({ fullPage, type: "jpeg", quality: 100 } as any);
        times.totalInstanceTime = Date.now() - startTime;

        await stopRecording(sessionService);
        return screenshot;
      },
    );

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send(screenshot);
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    return reply.code(500).send({ message: error });
  }
};

export const handlePDF = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: PDFRequest,
  reply: FastifyReply,
) => {
  const startTime = Date.now();
  let times: Record<string, number> = {};
  const { url, logUrl, proxyUrl } = request.body;

  try {
    const pdf = await withScraperSession(
      sessionService,
      browserService,
      (msg) => request.log.info(msg),
      { proxyUrl },
      async (page) => {
        if (url) {
          const normalizedUrl = normalizeUrl(url);
          if (!normalizedUrl) {
            throw new Error(`Invalid URL: ${url}`);
          }
          await page.goto(normalizedUrl, { timeout: 45000, waitUntil: "domcontentloaded" });
          const content = await waitForPageContent(page, { timeoutMs: 30_000, pollMs: 750 });
          times.contentReadyWaitMs = content.waitedMs;
        }

        const pdf = await page.pdf();
        times.totalInstanceTime = Date.now() - startTime;
        return pdf;
      },
    );

    if (logUrl) {
      await updateLog(logUrl, { times });
    }

    return reply.send(pdf);
  } catch (e: unknown) {
    const error = getErrors(e);

    if (logUrl) {
      await updateLog(logUrl, { times, response: { browserError: error } });
    }

    return reply.code(500).send({ message: error });
  }
};
