import { Page } from "puppeteer-core";

/**
 * Detect common bot-challenge interstitials (Cloudflare, etc.).
 */
export async function isChallengePage(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const title = (document.title || "").toLowerCase();
      const body = (document.body?.innerText || "").toLowerCase().slice(0, 2000);
      const html = (document.documentElement?.innerHTML || "").toLowerCase().slice(0, 5000);

      const titleHits =
        title.includes("just a moment") ||
        title.includes("attention required") ||
        title.includes("security check") ||
        title.includes("checking your browser");

      const bodyHits =
        body.includes("performing security verification") ||
        body.includes("checking your browser before accessing") ||
        body.includes("enable javascript and cookies to continue") ||
        body.includes("verify you are human") ||
        body.includes("cf-browser-verification") ||
        body.includes("challenge-platform");

      const htmlHits =
        html.includes("cf-challenge") ||
        html.includes("challenge-platform") ||
        html.includes("turnstile") ||
        html.includes("cf-browser-verification") ||
        html.includes("cdn-cgi/challenge");

      return titleHits || bodyHits || htmlHits;
    });
  } catch {
    return false;
  }
}

export interface WaitForChallengeOptions {
  /** Max time to wait for the challenge to clear (ms). Default 60000. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 1000. */
  pollMs?: number;
  /** Optional logger */
  log?: (msg: string) => void;
}

/**
 * Wait until a bot challenge interstitial clears (or timeout).
 * Works with extensions like NopeCHA that auto-solve Turnstile/hCaptcha/reCAPTCHA.
 * Returns true if the page is no longer a challenge page.
 */
export async function waitForChallengeClear(
  page: Page,
  options: WaitForChallengeOptions = {},
): Promise<{ cleared: boolean; waitedMs: number }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const log = options.log ?? (() => {});
  const start = Date.now();

  if (!(await isChallengePage(page))) {
    return { cleared: true, waitedMs: 0 };
  }

  log(`[waitForChallenge] Challenge detected, waiting up to ${timeoutMs}ms for clearance`);

  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) {
      return { cleared: false, waitedMs: Date.now() - start };
    }

    // Prefer network-ish settles without being too strict
    try {
      await page.waitForFunction(
        () => {
          const title = (document.title || "").toLowerCase();
          return !title.includes("just a moment") && !title.includes("attention required");
        },
        { timeout: pollMs, polling: 500 },
      );
    } catch {
      // poll window elapsed — re-check below
    }

    const stillChallenge = await isChallengePage(page);
    if (!stillChallenge) {
      const waitedMs = Date.now() - start;
      log(`[waitForChallenge] Challenge cleared after ${waitedMs}ms`);
      // Brief settle for post-challenge redirects
      await new Promise((r) => setTimeout(r, 500));
      return { cleared: true, waitedMs };
    }
  }

  const waitedMs = Date.now() - start;
  log(`[waitForChallenge] Timed out after ${waitedMs}ms still on challenge page`);
  return { cleared: false, waitedMs };
}
