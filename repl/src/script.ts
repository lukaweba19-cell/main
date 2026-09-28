import { chromium } from "patchright";

async function run() {
  // Attach to the Steel browser over its CDP endpoint.
  // The headful browser starts automatically when a session or scrape runs.
  const cdpEndpoint = "http://127.0.0.1:9222";
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();

  try {
    await page.goto("https://steel.dev");
    console.log(`Page title: ${await page.title()}`);
  } finally {
    await page.close();
    await browser.close(); // disconnects without killing the browser
  }
}

run().catch(console.error);
