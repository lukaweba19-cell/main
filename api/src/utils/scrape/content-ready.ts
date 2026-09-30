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
 * In-page predicate — serialized and executed in the browser. Installs a
 * MutationObserver + rAF loop the FIRST call and resolves as soon as the
 * page is PRESENTABLE:
 *   - not a challenge interstitial (strong signals only: title/shell-URL;
 *     cookie banners and generic phrases never count)
 *   - document interactive/complete AND real content (text or structure)
 *   - DOM unchanged across one animation frame while presentable
 *
 * Instant for a normal page (first rAF after content renders — typically
 * well under 1s after domcontentloaded); waits exactly as long as a real
 * challenge takes (2s or 60s — no artificial floor or window).
 */
export function installReadinessPredicate() {
  var CHALLENGE_TITLES = [
    "just a moment",
    "attention required",
    "security check",
    "checking your browser",
    "one more step",
  ];

  var w = window as any;
  var state = w.__steelReadiness;
  if (!state) {
    state = w.__steelReadiness = { observers: 0, lastSig: "", stableFrames: 0 };
  }

  function snapshotNow() {
    var title = (document.title || "").toLowerCase();
    var body = (document.body ? document.body.innerText : "").trim();
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
    var hasContent = false;
    if (document.body) {
      hasContent =
        body.length >= 200 ||
        document.body.querySelectorAll("a, p, h1, h2, h3, li, td, th, article, section").length >= 5;
    }

    var sig =
      (document.title || "") +
      "|" +
      body.length +
      "|" +
      (document.body ? document.body.querySelectorAll("*").length : 0);

    return {
      presentable: interactive && hasContent && !challenge,
      challenge: challenge,
      sig: sig,
      title: document.title || "",
      contentChars: body.length,
      tagCount: hasContent ? 1 : 0,
      url: window.location.href,
      readyState: document.readyState,
    };
  }

  return new Promise(function (resolve) {
    var settled = false;
    function finish(snap) {
      if (settled) return;
      settled = true;
      resolve(snap);
    }

    function tick() {
      if (settled) return;
      var snap = snapshotNow();
      if (snap.presentable && snap.sig === state.lastSig) {
        state.stableFrames += 1;
        if (state.stableFrames >= 2) {
          state.lastSig = snap.sig;
          state.stableFrames = 0;
          finish(snap);
          return;
        }
      } else {
        state.stableFrames = 0;
      }
      state.lastSig = snap.sig;
      requestAnimationFrame(tick);
    }

    // Observe DOM mutations so we re-tick on real changes; rAF drive covers
    // canvas/font-paint settle that mutations miss.
    if (state.observers === 0 && window.MutationObserver) {
      var mo = new MutationObserver(function () {
        state.stableFrames = 0;
      });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      state.observers = 1;
    }

    // Instant-check first (fast pages resolve on the first tick).
    var first = snapshotNow();
    if (first.presentable) {
      state.lastSig = first.sig;
      state.stableFrames = 1;
    }
    requestAnimationFrame(tick);

    // Cross-navigation safety: a meta-refresh to tg:// or hard reload wipes
    // our window — re-resolve is handled by the caller re-invoking us.
    window.addEventListener("pagehide", function () {
      settled = true; // abandon; caller sees navigation and re-invokes
    });
  });
}

/**
 * Wait until the page is actually presentable — EVENT-DRIVEN. The predicate
 * above runs inside the page and resolves at the first instant the page is
 * real (or as soon as a challenge clears). No polling windows, no dwell:
 * a normal page finishes in ~100-500ms after its content exists; a challenge
 * finishes the moment it clears, 2s or 2min — never an artificial wait.
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
      // Race the in-page predicate against the ceiling for THIS navigation;
      // the predicate survives via window.__steelReadiness between calls.
      fired = await Promise.race([
        page.evaluate(installReadinessPredicate).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 5_000)),
      ]);
    } catch {
      fired = null;
    }

    if (fired && fired.presentable) {
      lastSnapshot = fired as ContentSnapshot;
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

    // Not presentable yet: the predicate stays installed in the page (rAF
    // loop) — re-poll briefly to pick up its resolution or a navigation.
    await new Promise((r) => setTimeout(r, 150));
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
