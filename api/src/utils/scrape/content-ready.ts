import type { Page } from "patchright";

/**
 * Automatic "the site is actually loaded" detection.
 *
 * Instead of a fixed delay, we watch the page itself and finish the scrape the
 * moment the requested content is really there:
 *
 *   1. Challenge interstitials (Cloudflare & friends) are detected and waited
 *      out while the loaded extensions solve them. The check is title/body
 *      based — Cloudflare's challenge <script> tags stay in the DOM after the
 *      challenge clears, so they must never count as "still challenged".
 *   2. Once unchallenged, we wait for the page to go quiet: document ready,
 *      no in-flight requests (network idle) and a stable DOM (no mutation for
 *      a settle window). The first poll that satisfies all three returns —
 *      no fixed timeout burn.
 *   3. Simple, small pages (example.com) qualify immediately, so they finish
 *      in seconds instead of waiting out the whole timeout.
 */

const CHALLENGE_TITLES = [
  "just a moment",
  "attention required",
  "security check",
  "checking your browser",
  "one more step",
];

const CHALLENGE_BODY_PHRASES = [
  "performing security verification",
  "checking your browser before accessing",
  "verify you are human",
  "confirm you are human",
  "enable javascript and cookies to continue",
  "needs to review the security of your connection",
];

/** Challenge page shell: nearly no real DOM content. */
const CHALLENGE_MAX_CONTENT_CHARS = 300;

/** Real-content thresholds (small pages must pass trivially). */
const MIN_CONTENT_CHARS = 200;
const MIN_TAG_COUNT = 5;

/** No request may be in flight during this window to call the page quiet. */
const QUIET_WINDOW_MS = 1200;
/** DOM must be unchanged for this long before we accept it as settled. */
const DOM_SETTLE_MS = 1200;
/** How long a challenge may take to clear before we give up waiting. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Poll cadence while waiting for readiness. */
const POLL_MS = 500;

function isChallengeTitle(title: string): boolean {
  const t = (title || "").toLowerCase();
  return CHALLENGE_TITLES.some((s) => t.includes(s));
}

/**
 * Runs in the page: challenge/content signature of the current DOM.
 *
 * IMPORTANT: this function is serialized and executed in the browser, so it
 * must not reference anything from this module's scope — inline all constants.
 *
 * Challenge detection deliberately ignores script src/urls: Cloudflare leaves
 * challenge-platform/turnstile script tags in the DOM long after the challenge
 * has been solved, and counting them kept scrapes alive for the full timeout.
 */
function pageSnapshot() {
  var CHALLENGE_TITLES = [
    "just a moment",
    "attention required",
    "security check",
    "checking your browser",
    "one more step",
  ];
  var CHALLENGE_BODY_PHRASES = [
    "performing security verification",
    "checking your browser before accessing",
    "verify you are human",
    "confirm you are human",
    "enable javascript and cookies to continue",
    "needs to review the security of your connection",
  ];
  var CHALLENGE_MAX_CONTENT_CHARS = 300;

  var title = (document.title || "").toLowerCase();
  var body = (document.body?.innerText || "").trim();
  var bodyLower = body.toLowerCase();

  var titleChallenged = CHALLENGE_TITLES.some(function (s) {
    return title.includes(s);
  });
  var bodyChallenged =
    CHALLENGE_BODY_PHRASES.some(function (s) {
      return bodyLower.includes(s);
    }) && body.length < 2000; // challenge shells are short; real pages never match

  var challenge =
    titleChallenged || (bodyChallenged && body.length < CHALLENGE_MAX_CONTENT_CHARS);

  var tagCount = document.querySelectorAll(
    "a, p, h1, h2, h3, li, td, th, article, section",
  ).length;
  var contentChars = body.length;
  var pendingImages = Array.from(document.images).filter(function (img) {
    return !img.complete;
  }).length;

  return {
    challenge: challenge,
    title: document.title || "",
    contentChars: contentChars,
    tagCount: tagCount,
    pendingImages: pendingImages,
    url: window.location.href,
    readyState: document.readyState,
  };
}

export type ContentSnapshot = {
  challenge: boolean;
  title: string;
  contentChars: number;
  tagCount: number;
  pendingImages: number;
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

/** True when the DOM holds real, parseable content (small pages pass trivially). */
export function hasRealContent(snap: ContentSnapshot): boolean {
  if (snap.challenge) return false;
  if (snap.readyState !== "complete" && snap.readyState !== "interactive") {
    return false;
  }
  return snap.contentChars >= MIN_CONTENT_CHARS || snap.tagCount >= MIN_TAG_COUNT;
}

/** True when the page is unchallenged, real, and fully settled (loaded). */
export function isPageSettled(snap: ContentSnapshot): boolean {
  return hasRealContent(snap) && snap.readyState === "complete";
}

export interface WaitForContentOptions {
  /** Max time to wait for content (ms). Default 60000. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 500. */
  pollMs?: number;
  /** No in-flight requests for this long counts as network-quiet. Default 1200. */
  quietWindowMs?: number;
  /** DOM unchanged for this long counts as settled. Default 1200. */
  domSettleMs?: number;
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
  /** True when we returned because the page looked fully settled. */
  settled: boolean;
  waitedMs: number;
  snapshot: ContentSnapshot | null;
}

/**
 * Wait until the page is actually loaded: not challenged, real content
 * present, network quiet and DOM stable. Returns the moment that is true.
 */
export async function waitForPageContent(
  page: Page,
  options: WaitForContentOptions = {},
): Promise<WaitForContentResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const quietWindowMs = options.quietWindowMs ?? QUIET_WINDOW_MS;
  const domSettleMs = options.domSettleMs ?? DOM_SETTLE_MS;
  const log = options.log ?? (() => {});
  const start = Date.now();

  let challengeDetected = false;
  let challengeCleared = false;
  let lastSnapshot: ContentSnapshot | null = null;
  let lastGoodSnapshot: ContentSnapshot | null = null;

  // Poll-based quiet/settle tracking (no CDP session needed; works everywhere).
  let quietSince: number | null = null;
  let lastSignature: string | null = null;
  let stableSince: number | null = null;

  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) break;

    lastSnapshot = await snapshotPage(page);
    if (!lastSnapshot) {
      quietSince = null;
      stableSince = null;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    // 1. Challenge interstitial: wait it out (extensions solve it).
    if (lastSnapshot.challenge || isChallengeTitle(lastSnapshot.title)) {
      if (!challengeDetected) {
        challengeDetected = true;
        log(`[waitForContent] Challenge detected, waiting for automatic solve`);
      }
      quietSince = null;
      stableSince = null;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    if (challengeDetected) {
      challengeCleared = true;
      log(
        `[waitForContent] Challenge cleared after ${Date.now() - start}ms — waiting for page to settle`,
      );
      challengeDetected = false; // cleared; keep waiting for real load
      quietSince = null;
      stableSince = null;
      lastSignature = null;
    }

    // 2. Real content not there yet — keep waiting.
    if (!hasRealContent(lastSnapshot)) {
      quietSince = null;
      stableSince = null;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    lastGoodSnapshot = lastSnapshot;

    // 3. Track quiet + stability. Signature is cheap DOM fingerprint.
    const signature = `${lastSnapshot.title}|${lastSnapshot.contentChars}|${lastSnapshot.tagCount}`;
    const now = Date.now();
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = now;
    }
    const stableFor = now - (stableSince ?? now);

    // Images still loading counts as activity.
    const busy = lastSnapshot.pendingImages > 0;
    if (!busy && quietSince === null) quietSince = now;
    if (busy) quietSince = null;
    const quietFor = busy ? 0 : now - (quietSince ?? now);

    const settled = quietFor >= quietWindowMs && stableFor >= domSettleMs;
    if (settled) {
      const waitedMs = now - start;
      log(
        `[waitForContent] Page settled after ${waitedMs}ms` +
          (challengeCleared ? " (challenge cleared earlier)" : ""),
      );
      return {
        ready: true,
        challengeDetected: challengeCleared,
        challengeCleared,
        settled: true,
        waitedMs,
        snapshot: lastSnapshot,
      };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  const waitedMs = Date.now() - start;
  const finalSnap = lastGoodSnapshot ?? lastSnapshot;
  log(
    `[waitForContent] Finished after ${waitedMs}ms — ready=${finalSnap ? hasRealContent(finalSnap) : false}` +
      `, challengeSeen=${challengeCleared}`,
  );

  return {
    ready: finalSnap ? hasRealContent(finalSnap) : false,
    challengeDetected: challengeCleared,
    challengeCleared,
    settled: false,
    waitedMs,
    snapshot: finalSnap,
  };
}

export { MIN_CONTENT_CHARS, MIN_TAG_COUNT };
