import { FastifyReply } from "fastify";
import { getErrors } from "../../utils/errors.js";
import { normalizeUrl } from "../../utils/url.js";
import { getDefuddleContent } from "../../utils/scrape/readability.js";
import { isJsonContentType } from "../../utils/scrape/jsonToMarkdown.js";
import { safeGoto } from "../../utils/scrape/safeGoTo.js";
import {
  launchIsolatedBrowser,
  waitForCheckReady,
  xreactorBrowserPool,
} from "./xreactor.browser.js";
import {
  CRAWL_TOTAL_BUDGET_MS,
  MAX_EXTRA_PAGES,
  MAX_LINKS_PER_PAGE,
  PER_PAGE_TIMEOUT_MS,
  harvestLinks,
  scanTextForCloud,
  type ClassifiedLink,
} from "./xreactor.scanner.js";
import { MAX_URLS_PER_REQUEST, type XReactorRequest } from "./xreactor.schema.js";

export interface PageVerdict {
  url: string;
  finalUrl: string | null;
  status: "ok" | "error" | "skipped";
  cloudFound: boolean;
  matches: Array<{ variant: string; excerpt: string }>;
  markdownChars: number;
  error?: string;
  followedFrom: string | null;
}

export interface XReactorResult {
  result: "allowed" | "disallowed";
  seedUrl: string;
  pages: PageVerdict[];
  links: {
    found: number;
    followed: string[];
    skippedAds: number;
    skippedBinary: number;
    skippedOther: number;
  };
  timings: {
    totalMs: number;
  };
  error?: string;
}

interface LinkSkipCounters {
  ad: number;
  binary: number;
  foreign: number;
  other: number;
}

const EMPTY_SKIPPED: LinkSkipCounters = { ad: 0, binary: 0, foreign: 0, other: 0 };

/**
 * Navigates to `url`, waits for the text to be present (lightweight readiness,
 * ~1-2s on normal pages), extracts markdown via Defuddle and returns the
 * verdict + harvested candidate links for the follow queue.
 */
async function visitPage(
  page: import("patchright").Page,
  url: string,
  followedFrom: string | null,
): Promise<{ verdict: PageVerdict; candidates: ClassifiedLink[]; skipped: LinkSkipCounters }> {
  const verdict: PageVerdict = {
    url,
    finalUrl: null,
    status: "ok",
    cloudFound: false,
    matches: [],
    markdownChars: 0,
    followedFrom,
  };

  try {
    const safeResponse = await safeGoto(page, url, {
      timeout: PER_PAGE_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    const response0 = safeResponse.response ?? safeResponse.pdfResponse;
    const contentType = response0?.headers()["content-type"]?.toLowerCase() || "";
    const isPdf = safeResponse.isPdf || contentType.includes("application/pdf");
    const isJson = isJsonContentType(contentType);

    if (!isPdf && !isJson) {
      await waitForCheckReady(page);
    }

    verdict.finalUrl = page.url();

    // Links come from the raw DOM — markdown strips hrefs.
    let candidates: ClassifiedLink[] = [];
    let skipped = EMPTY_SKIPPED;
    if (!isPdf) {
      const rawHtml = await page.content();
      const harvest = harvestLinks(rawHtml, verdict.finalUrl || url, MAX_LINKS_PER_PAGE);
      candidates = harvest.candidates;
      skipped = harvest.skipped;
    }

    let markdown = "";
    if (isJson) {
      markdown = (await response0?.text()) ?? "";
    } else {
      const html = await page.content();
      const defuddled = await getDefuddleContent(html, verdict.finalUrl || url);
      markdown = defuddled.contentMarkdown ?? defuddled.content ?? "";
      if (!markdown && isPdf) {
        markdown = url; // PDFs: at least scan the URL itself.
      }
    }

    const scan = scanTextForCloud(String(markdown || ""));
    verdict.cloudFound = scan.cloudFound;
    verdict.matches = scan.matches;
    verdict.markdownChars = markdown.length;

    return { verdict, candidates, skipped };
  } catch (e: unknown) {
    verdict.status = "error";
    verdict.error = getErrors(e);
    return { verdict, candidates: [], skipped: EMPTY_SKIPPED };
  }
}

/**
 * The crawl for ONE seed URL in its own private browser:
 *   launch isolated CloakBrowser -> check seed -> follow up to
 *   MAX_EXTRA_PAGES links -> close + delete profile.
 */
async function crawl(log: (msg: string) => void, seedUrl: string): Promise<XReactorResult> {
  return xreactorBrowserPool.run(async () => {
    const startMs = Date.now();
    const browser = await launchIsolatedBrowser(log);

    try {
      const { page } = browser;
      const pages: PageVerdict[] = [];
      const followed: string[] = [];
      const visited = new Set<string>();
      const totals = { ad: 0, binary: 0, foreign: 0, other: 0 };
      let queue: Array<{ url: string; from: string | null }> = [{ url: seedUrl, from: null }];
      const finishedPages = () => pages.filter((p) => p.status !== "error").length;

      while (queue.length > 0) {
        if (Date.now() - startMs > CRAWL_TOTAL_BUDGET_MS) {
          log(`[xreactor] budget exceeded for ${seedUrl}, stopping crawl`);
          break;
        }
        if (finishedPages() > MAX_EXTRA_PAGES) break;

        const item = queue.shift()!;
        const key = item.url.replace(/\/$/, "");
        if (visited.has(key)) continue;
        visited.add(key);

        const { verdict, candidates, skipped } = await visitPage(page, item.url, item.from);
        totals.ad += skipped.ad;
        totals.binary += skipped.binary;
        totals.foreign += skipped.foreign;
        totals.other += skipped.other;
        pages.push(verdict);

        if (verdict.cloudFound) {
          return {
            result: "disallowed",
            seedUrl,
            pages,
            links: {
              found: candidates.length,
              followed,
              skippedAds: totals.ad,
              skippedBinary: totals.binary,
              skippedOther: totals.other + totals.foreign,
            },
            timings: { totalMs: Date.now() - startMs },
          };
        }

        if (item.from === null) {
          // Only the seed page's links seed the follow queue (cap: 3 extra).
          for (const candidate of candidates) {
            if (followed.length >= MAX_EXTRA_PAGES) break;
            if (visited.has(candidate.url.replace(/\/$/, ""))) continue;
            queue.push({ url: candidate.url, from: item.url });
            followed.push(candidate.url);
          }
        }
      }

      return {
        result: "allowed",
        seedUrl,
        pages,
        links: {
          found: followed.length,
          followed,
          skippedAds: totals.ad,
          skippedBinary: totals.binary,
          skippedOther: totals.other + totals.foreign,
        },
        timings: { totalMs: Date.now() - startMs },
      };
    } finally {
      await browser.close();
    }
  });
}

const failedResult = (target: string, error: string): XReactorResult => ({
  result: "allowed",
  seedUrl: target,
  pages: [
    {
      url: target,
      finalUrl: null,
      status: "error",
      cloudFound: false,
      matches: [],
      markdownChars: 0,
      followedFrom: null,
      error,
    },
  ],
  links: { found: 0, followed: [], skippedAds: 0, skippedBinary: 0, skippedOther: 0 },
  timings: { totalMs: 0 },
  error,
});

export const handleXReactorCheck = async (
  request: XReactorRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const { url, urls } = request.body;

  // Accept one URL or many: `url` as string, `url` as array, or `urls` array.
  const rawUrls = [
    ...(Array.isArray(url) ? url : url ? [url] : []),
    ...(urls ?? []),
  ];

  if (rawUrls.length === 0) {
    return reply.code(400).send({ message: "Provide `url` (string or array) or `urls`" });
  }
  if (rawUrls.length > MAX_URLS_PER_REQUEST) {
    return reply
      .code(400)
      .send({ message: `Too many URLs (max ${MAX_URLS_PER_REQUEST} per request)` });
  }

  const normalizedUrls: string[] = [];
  for (const raw of rawUrls) {
    const normalized = normalizeUrl(raw);
    if (!normalized) {
      return reply.code(400).send({ message: `Invalid URL: ${raw}` });
    }
    normalizedUrls.push(normalized);
  }

  const log = (msg: string) => request.log.info(msg);

  try {
    if (normalizedUrls.length === 1) {
      const result = await crawl(log, normalizedUrls[0]);
      return reply.send(result);
    }

    // Batch: every URL gets its OWN browser, all running at the same time
    // (bounded by XREACTOR_MAX_CONCURRENT). One URL failing never blocks the
    // others.
    const batchStart = Date.now();
    const settled = await Promise.all(
      normalizedUrls.map(async (target): Promise<XReactorResult> => {
        try {
          return await crawl(log, target);
        } catch (e: unknown) {
          const error = getErrors(e);
          request.log.warn({ err: error, url: target }, "xreactor batch item failed");
          return failedResult(target, error);
        }
      }),
    );

    return reply.send({
      results: settled,
      summary: {
        total: settled.length,
        allowed: settled.filter((r) => r.result === "allowed").length,
        disallowed: settled.filter((r) => r.result === "disallowed").length,
        pagesErrored: settled.reduce(
          (n, r) => n + r.pages.filter((p) => p.status === "error").length,
          0,
        ),
        totalMs: Date.now() - batchStart,
      },
    });
  } catch (e: unknown) {
    const error = getErrors(e);
    return reply.code(500).send({ message: error });
  }
};
