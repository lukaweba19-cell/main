import type { Page } from "patchright";

/**
 * Automatic "the site is actually loaded" detection.
 *
 * Instead of a fixed delay, we watch the page itself and finish the scrape the
 * moment the requested content is really there:
 *
 *   1. Challenge interstitials (Cloudflare & friends) are detected and waited
 *      out while the loaded extensions solve them. The check is title/path
 *      based — Cloudflare's challenge <script> tags stay in the DOM after the
 *      challenge clears, so they must never count as "still challenged".
 *   2. Once unchallenged, we wait for the page to be PRESENTABLE (rendered
 *      content) and to STAY presentable for a short settle window. Settle is
 *      time-based (wall-clock), NOT mutation-gated: animated pages (hero
 *      carousels, live tickers, tracker churn) mutate forever, and a
 *      "DOM unchanged for N frames" gate would never fire — that was the bug
 *      that burned 45s ceilings on fully rendered pages.
 *   3. The predicate is STATELESS PER CALL: every invocation owns its own
 *      closure state. No shared window state, no cross-call observers, no
 *      pagehide dead-loops. Simple pages resolve on the first poll.
 */

/** Challenge titles — strong interstitial signals only. */
const CHALLENGE_TITLES = [
  "just a moment",
  "attention required",
  "security check",
  "checking your browser",
  "one more step",
];

/** Challenge body phrases (legacy snapshot support). */
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

/** The page must STAY presentable for this long before we accept it. */
export const PRESENTABLE_SETTLE_MS = 800;
/** How long a challenge may take to clear before we give up (failure ceiling). */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Outer re-poll cadence while waiting for readiness. */
const POLL_MS = 250;
/** Max wall-clock time the in-page predicate waits before returning a status. */
const IN_PAGE_MAX_WAIT_MS = 4_000;

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
  /**
   * SAFETY CEILING only — never the normal exit. The predicate resolves the
   * moment the page is presentable; this bounds a page that never renders
   * (dead tab, hard challenge). Default 45000.
   */
  timeoutMs?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface WaitForContentResult {
  /** Page ended up with real parseable content. */
  ready: boolean;
  /** Page was showing a challenge at some point. */
  challengeDetected: boolean;
  /** If seen, whether the challenge cleared. */
  challengeCleared: boolean;
  /** True when the predicate fired (the normal path). */
  settled: boolean;
  waitedMs: number;
  snapshot: ContentSnapshot | null;
}

/**
 * In-page predicate — serialized and executed in the browser.
 *
 * STATELESS: all state lives in this invocation's closure. Polls its own
 * snapshot on a 100ms cadence (no rAF dependency — rAF throttles/stalls in
 * occluded or busy tabs) and resolves the moment the page has been
 * CONTINUOUSLY presentable for PRESENTABLE_SETTLE_MS (wall-clock, so DOM
 * churn from animations cannot reset it — presence, not change, is measured).
 *
 * Presentable = document interactive/complete AND (body text OR >=3
 * structural tags) AND not a challenge. A non-empty <title> alone NEVER
 * counts as content: t.me paints the title while the body is still blank,
 * and counting it released sessions on white pages.
 *
 * Returns when presentable-and-settled, or after IN_PAGE_MAX_WAIT_MS with
 * status:"waiting" — the outer loop then simply re-invokes us (stateless, so
 * re-invocation is free) or runs a final snapshot.
 */
export function installReadinessPredicate() {
  var CHALLENGE_TITLES = [
    "just a moment",
    "attention required",
    "security check",
    "checking your browser",
    "one more step",
  ];
  var SETTLE_MS = 800;
  var MAX_WAIT_MS = 4000;

  var w = window as any;
  if (w.__steelReadiness) {
    try {
      delete w.__steelReadiness;
    } catch {
      /* leave it — nothing reads it any more */
    }
  }

  function snapshotNow() {
    var title = (document.title || "").toLowerCase();
    var body = document.body ? document.body.innerText : "";
    var path = (window.location.pathname || "").toLowerCase();
    var titleChallenged = CHALLENGE_TITLES.some(function (s) {
      return title.indexOf(s) !== -1;
    });
    // Strong challenge URL signature only (Cloudflare/subject pages live on
    // well-known paths). Generic phrases are NOT signals — cookie banners on
    // real pages made the old detector false-positive and burn 28s.
    var challengePath =
      path.indexOf("/cdn-cgi/") !== -1 || path.indexOf("challenge") !== -1;
    var challenge = titleChallenged || challengePath;

    var interactive =
      document.readyState === "interactive" || document.readyState === "complete";

    // Presentable content = real rendered material: body text (even a short
    // t.me profile) or structural tags. A non-empty <title> alone never
    // counts — t.me paints the title while the body is still white.
    var hasContent = false;
    if (document.body) {
      var structural = document.body.querySelectorAll(
        "a, p, h1, h2, h3, li, td, th, article, section",
      ).length;
      hasContent = body.length > 0 || structural >= 3;
    }

    return {
      presentable: !!(interactive && hasContent && !challenge),
      challenge: challenge,
      title: document.title || "",
      contentChars: body.trim().length,
      tagCount: 0,
      url: window.location.href,
      readyState: document.readyState,
    };
  }

  return new Promise(function (resolve) {
    var settled = false;
    var start = Date.now();
    var presentableSince = -1; // timestamp when the page FIRST became presentable

    function finish(snap: any) {
      if (settled) return;
      settled = true;
      resolve(snap);
    }

    function poll() {
      if (settled) return;
      var snap = snapshotNow();
      var now = Date.now();

      if (snap.presentable) {
        if (presentableSince < 0) presentableSince = now;
        if (now - presentableSince >= SETTLE_MS) {
          finish(snap);
          return;
        }
      } else {
        presentableSince = -1;
      }

      if (now - start >= MAX_WAIT_MS) {
        // Report current status; the caller decides (re-invoke or finish).
        finish({ presentable: false, waiting: true, challenge: snap.challenge, snapshot: snap });
        return;
      }

      setTimeout(poll, 100);
    }

    poll();

    // Navigations abandon this invocation instantly; the caller's outer loop
    // re-invokes the (stateless) predicate on the new document.
    window.addEventListener(
      "pagehide",
      function () {
        finish({ presentable: false, waiting: true, navigated: true });
      },
      { once: true },
    );
  });
}

/**
 * Wait until the page is actually presentable — EVENT-DRIVEN with a
 * wall-clock settle window. The stateless in-page predicate resolves when
 * the page has stayed presentable for PRESENTABLE_SETTLE_MS; the outer loop
 * re-invokes it (cheap — no page state involved) until success or ceiling.
 *
 * Normal pages: ~1s after their content exists (settle window).
 * Challenges: exactly as long as the challenge takes, once cleared content
 * holds and it resolves immediately — no artificial floor or dwell.
 */
export async function waitForPageContent(
  page: Page,
  options: WaitForContentOptions = {},
): Promise<WaitForContentResult> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const log = options.log ?? (() => {});
  const start = Date.now();
  let challengeSeen = false;
  let lastSnapshot: ContentSnapshot | null = null;

  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) break;

    let fired: any = null;
    try {
      // Stateless predicate: resolves presentable, or status:"waiting" after
      // its in-page budget, or immediately on navigation (pagehide).
      fired = await Promise.race([
        page.evaluate(installReadinessPredicate).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 5_000)),
      ]);
    } catch {
      fired = null;
    }

    if (fired && fired.snapshot) {
      lastSnapshot = fired.snapshot as ContentSnapshot;
    }

    if (fired && fired.presentable) {
      lastSnapshot = (fired.snapshot ?? lastSnapshot) as ContentSnapshot;
      const waitedMs = Date.now() - start;
      log(
        `[waitForContent] Page presentable after ${waitedMs}ms` +
          (challengeSeen ? " (challenge cleared)" : ""),
      );
      return {
        ready: true,
        challengeDetected: challengeSeen,
        challengeCleared: challengeSeen,
        settled: true,
        waitedMs,
        snapshot: lastSnapshot,
      };
    }

    if (fired && fired.challenge) {
      if (!challengeSeen) {
        challengeSeen = true;
        log(`[waitForContent] Challenge detected — resolving the instant it clears`);
      }
    }

    // Not presentable yet: re-invoke the stateless predicate (fresh closure,
    // re-measures the settle window on the CURRENT DOM) after a short pause.
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const waitedMs = Date.now() - start;
  const finalSnap = (await snapshotPage(page).catch(() => null)) ?? lastSnapshot;
  log(
    `[waitForContent] Ceiling after ${waitedMs}ms — ready=${finalSnap ? hasRealContent(finalSnap) : false}` +
      `, challengeSeen=${challengeSeen}`,
  );
  return {
    ready: finalSnap ? hasRealContent(finalSnap) : false,
    challengeDetected: challengeSeen,
    challengeCleared: challengeSeen,
    settled: false,
    waitedMs,
    snapshot: finalSnap,
  };
}

export { MIN_CONTENT_CHARS, MIN_TAG_COUNT };
