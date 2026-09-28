import type { Page } from "patchright";

/**
 * Cloudflare and similar bot checks are solved automatically by the headful
 * browser (the extensions we load handle Turnstile/hCaptcha/reCAPTCHA). Instead
 * of the old fixed `delay` guessing game, we detect the transition directly:
 *
 *   challenge page  ->  cleared  ->  real content parsed from the HTML
 *
 * The wait finishes as soon as the page holds parseable content bigger than any
 * challenge payload, or the timeout elapses (whichever comes first).
 */

const MIN_CONTENT_CHARS = 500;
const MIN_MARKDOWN_CHARS = 200;

function isChallengeTitle(title: string): boolean {
  const t = (title || "").toLowerCase();
  return (
    t.includes("just a moment") ||
    t.includes("attention required") ||
    t.includes("security check") ||
    t.includes("checking your browser") ||
    t.includes("one more step")
  );
}

/** Runs in the page: returns the challenge/content signature of the current DOM. */
function pageSnapshot() {
  const title = (document.title || "").toLowerCase();
  const body = (document.body?.innerText || "").trim();
  const html = (document.documentElement?.innerHTML || "").toLowerCase();

  const challenge =
    title.includes("just a moment") ||
    title.includes("attention required") ||
    title.includes("security check") ||
    title.includes("checking your browser") ||
    body.includes("performing security verification") ||
    body.includes("checking your browser before accessing") ||
    body.includes("verify you are human") ||
    body.includes("enable javascript and cookies to continue") ||
    html.includes("cf-challenge") ||
    html.includes("challenge-platform") ||
    html.includes("turnstile") ||
    html.includes("cf-browser-verification") ||
    html.includes("cdn-cgi/challenge");

  // Real content heuristics: enough text, a reasonable tag count, and not
  // dominated by the challenge boilerplate.
  const tagCount = document.querySelectorAll("a, p, h1, h2, h3, li, td, th, article, section").length;
  const contentChars = body.length;

  return {
    challenge,
    title: document.title || "",
    contentChars,
    tagCount,
    url: window.location.href,
    readyState: document.readyState,
  };
}

export type ContentSnapshot = {
  challenge: boolean;
  title: string;
  contentChars: number;
  tagCount: number;
  url: string;
  readyState: string;
};

export async function snapshotPage(page: Page): Promise<ContentSnapshot | null> {
  try {
    if (page.isClosed()) return null;
    return (await page.evaluate(pageSnapshot)) as ContentSnapshot;
  } catch {
    return null;
  }
}

/** True while the page is still showing a bot-check interstitial. */
export async function isChallengePage(page: Page): Promise<boolean> {
  const snap = await snapshotPage(page);
  if (!snap) return false;
  return snap.challenge || isChallengeTitle(snap.title);
}

/** True when the DOM holds real, parseable content (well beyond a challenge shell). */
export function hasRealContent(snap: ContentSnapshot): boolean {
  if (snap.challenge) return false;
  if (snap.readyState !== "complete" && snap.readyState !== "interactive") return false;
  if (snap.contentChars < MIN_CONTENT_CHARS && snap.tagCount < 25) return false;
  // A challenge page typically has < 1KB of markup; require a real document.
  return snap.tagCount >= 10;
}

export interface WaitForContentOptions {
  /** Max time to wait for content (ms). Default 60000. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 750. */
  pollMs?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface WaitForContentResult {
  /** Page ended up with real parseable content. */
  ready: boolean;
  /** Page was showing a challenge at some point. */
  challengeDetected: boolean;
  /** If seen, whether the challenge cleared before timeout. */
  challengeCleared: boolean;
  waitedMs: number;
  snapshot: ContentSnapshot | null;
}

/**
 * Wait until the page either holds real content or times out. Detects
 * Cloudflare-style challenges automatically and waits for them to clear
 * (the loaded extensions solve them) — no user-configured delay needed.
 */
export async function waitForPageContent(
  page: Page,
  options: WaitForContentOptions = {},
): Promise<WaitForContentResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 750;
  const log = options.log ?? (() => {});
  const start = Date.now();

  let challengeDetected = false;
  let lastSnapshot: ContentSnapshot | null = null;

  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) break;

    lastSnapshot = await snapshotPage(page);
    if (!lastSnapshot) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    if (lastSnapshot.challenge || isChallengeTitle(lastSnapshot.title)) {
      if (!challengeDetected) {
        challengeDetected = true;
        log(`[waitForContent] Challenge detected, waiting for automatic solve`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    if (hasRealContent(lastSnapshot)) {
      const waitedMs = Date.now() - start;
      if (challengeDetected) {
        log(`[waitForContent] Challenge cleared after ${waitedMs}ms`);
      }
      return {
        ready: true,
        challengeDetected,
        challengeCleared: challengeDetected,
        waitedMs,
        snapshot: lastSnapshot,
      };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  const waitedMs = Date.now() - start;
  log(
    `[waitForContent] Finished after ${waitedMs}ms — ready=${hasRealContent(lastSnapshot ?? {
      challenge: false,
      title: "",
      contentChars: 0,
      tagCount: 0,
      url: "",
      readyState: "loading",
    })}, challengeDetected=${challengeDetected}`,
  );

  return {
    ready: lastSnapshot ? hasRealContent(lastSnapshot) : false,
    challengeDetected,
    challengeCleared: challengeDetected ? !!(lastSnapshot && !lastSnapshot.challenge) : false,
    waitedMs,
    snapshot: lastSnapshot,
  };
}

export { MIN_CONTENT_CHARS, MIN_MARKDOWN_CHARS };
