import { FastifyReply } from "fastify";
import { Page } from "patchright";
import { CDPService } from "../../services/cdp/cdp.service.js";
import { SessionService } from "../../services/session.service.js";
import { getErrors } from "../../utils/errors.js";
import { normalizeUrl } from "../../utils/url.js";
import { getDefuddleContent } from "../../utils/scrape/readability.js";
import { isJsonContentType } from "../../utils/scrape/jsonToMarkdown.js";
import { safeGoto } from "../../utils/scrape/safeGoTo.js";
import { waitForPageContent } from "../../utils/scrape/content-ready.js";
import { withScraperSession } from "../actions/actions.controller.js";
import {
  CRAWL_TOTAL_BUDGET_MS,
  MAX_EXTRA_PAGES,
  MAX_LINKS_PER_PAGE,
  PER_PAGE_TIMEOUT_MS,
  harvestLinks,
  scanTextForCloud,
  type ClassifiedLink,
} from "./xreactor.scanner.js";
import type { XReactorRequest } from "./xreactor.schema.js";

interface PageVerdict {
  url: string;
  finalUrl: string | null;
  status: "ok" | "error" | "skipped";
  cloudFound: boolean;
  matches: Array<{ variant: string; excerpt: string }>;
  markdownChars: number;
  error?: string;
  followedFrom: string | null;
}

interface XReactorResult {
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
}

/**
 * Navigates to `url`, waits for real content, extracts markdown via Defuddle
 * and returns the verdict + all harvested candidate links for BFS.
 */
async function visitPage(
  page: Page,
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
  const emptySkipped = { ad: 0, binary: 0, foreign: 0, other: 0 };

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
      await waitForPageContent(page, {
        timeoutMs: PER_PAGE_TIMEOUT_MS,
        pollMs: 750,
      });
    }

    verdict.finalUrl = page.url();

    // Harvest followable links from the raw DOM first — markdown strips
    // hrefs, so it is useless for link discovery.
    let candidates: ClassifiedLink[] = [];
    let skipped = emptySkipped;
    if (!isPdf) {
      const rawHtml = await page.content();
      const harvest = harvestLinks(rawHtml, verdict.finalUrl || url, MAX_LINKS_PER_PAGE);
      candidates = harvest.candidates;
      skipped = harvest.skipped;
    }

    let markdown = "";
    if (isJson) {
      const raw = (await response0?.text()) ?? "";
      markdown = raw;
    } else {
      const html = await page.content();
      const defuddled = await getDefuddleContent(html, verdict.finalUrl || url);
      markdown = defuddled.contentMarkdown ?? defuddled.content ?? "";
      if (!markdown && isPdf) {
        // PDFs: at least scan the URL itself.
        markdown = url;
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
    return { verdict, candidates: [], skipped: emptySkipped };
  }
}

interface LinkSkipCounters {
  ad: number;
  binary: number;
  foreign: number;
  other: number;
}

/** The crawl: seed page + up to MAX_EXTRA_PAGES child links, breadth-first. */
async function crawl(
  sessionService: SessionService,
  browserService: CDPService,
  log: (msg: string) => void,
  seedUrl: string,
): Promise<XReactorResult> {
  const startMs = Date.now();
  const pages: PageVerdict[] = [];
  const followed: string[] = [];
  const visited = new Set<string>();
  const totals = { ad: 0, binary: 0, foreign: 0, other: 0 };
  let queue: Array<{ url: string; from: string | null; depth: number }> = [
    { url: seedUrl, from: null, depth: 0 },
  ];

  return withScraperSession(
    sessionService,
    browserService,
    log,
    {},
    async (page) => {
      while (queue.length > 0) {
        const elapsed = Date.now() - startMs;
        if (elapsed > CRAWL_TOTAL_BUDGET_MS) {
          log(`[xreactor] total budget exceeded (${elapsed}ms), stopping crawl`);
          break;
        }
        if (pages.filter((p) => p.status !== "skipped").length > MAX_EXTRA_PAGES) {
          break;
        }

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
          log(`[xreactor] cloud variant found on ${item.url} — early exit`);
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

        if (item.depth === 0) {
          // Only the seed page's links seed the queue. Depth-1 pages are
          // scanned for cloud but their links are not followed, which keeps
          // the follow count at "up to 3 additional URLs".
          for (const candidate of candidates) {
            if (followed.length >= MAX_EXTRA_PAGES) break;
            if (visited.has(candidate.url.replace(/\/$/, ""))) continue;
            queue.push({ url: candidate.url, from: item.url, depth: 1 });
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
    },
  );
}

export const handleXReactorCheck = async (
  sessionService: SessionService,
  browserService: CDPService,
  request: XReactorRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const { url } = request.body;

  const normalized = normalizeUrl(url);
  if (!normalized) {
    return reply.code(400).send({ message: `Invalid URL: ${url}` });
  }

  try {
    const result = await crawl(
      sessionService,
      browserService,
      (msg) => request.log.info(msg),
      normalized,
    );
    return reply.send(result);
  } catch (e: unknown) {
    const error = getErrors(e);
    return reply.code(500).send({ message: error });
  }
};
