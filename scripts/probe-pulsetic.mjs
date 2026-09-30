// VM-side probe: why does page.goto("https://pulsetic.com/", {waitUntil:"domcontentloaded"}) time out?
import { chromium } from "patchright";
import { resolveBrowser } from "./build/utils/resolve-browser.js";
import { acquireXvfbDisplay } from "./build/modules/xreactor/xvfb-display.js";
import fs from "node:fs";
import os from "os";
import path from "node:path";

// Concurrency-safe: acquire a FREE display through the production allocator
// (same path every xreactor check uses) — never the shared :10.
const resolved = resolveBrowser();
const display = await acquireXvfbDisplay();
console.log("acquired display:", display.display, display.width + "x" + display.height);
const profileDir = path.join(os.tmpdir(), `probe-pulsetic-${Date.now()}`);
fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  executablePath: resolved.executablePath,
  args: ["--test-type", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
  env: { ...process.env, DISPLAY: display.display },
  timeout: 45000,
});
const page = ctx.pages()[0] || (await ctx.newPage());

const events = [];
page.on("request", (r) => {
  if (r.resourceType() === "document" && r.frame() === page.mainFrame())
    events.push({ t: Date.now(), ev: "request", url: r.url().slice(0, 100) });
});
page.on("response", (r) => {
  const req = r.request();
  if (req.resourceType() === "document" && req.frame() === page.mainFrame())
    events.push({ t: Date.now(), ev: `response ${r.status()} ct=${(r.headers()["content-type"] || "").slice(0, 40)}`, url: r.url().slice(0, 100) });
});
page.on("requestfailed", (r) => {
  if (r.resourceType() === "document" && r.frame() === page.mainFrame())
    events.push({ t: Date.now(), ev: `FAILED ${r.failure()?.errorText}`, url: r.url().slice(0, 100) });
});
page.on("domcontentloaded", () => events.push({ t: Date.now(), ev: "*** DCL fired ***", url: "" }));
page.on("load", () => events.push({ t: Date.now(), ev: "*** load fired ***", url: "" }));
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) events.push({ t: Date.now(), ev: "framenavigated", url: f.url().slice(0, 100) });
});

const t0 = Date.now();
try {
  await page.goto("https://pulsetic.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("goto OK in", Date.now() - t0, "ms");
} catch (e) {
  console.log("goto ERROR after", Date.now() - t0, "ms:", String(e.message).split("\n")[0]);
}

// State right now:
const state = await page.evaluate(() => ({
  url: location.href,
  rs: document.readyState,
  title: document.title.slice(0, 60),
  chars: (document.body?.innerText || "").length,
  nodes: document.body ? document.body.querySelectorAll("*").length : 0,
})).catch((e) => ({ evalErr: String(e.message).split("\n")[0] }));
console.log("page state:", JSON.stringify(state));
console.log("timeline:");
for (const e of events) console.log(" ", e.t - t0, "ms", e.ev, e.url);

await ctx.close().catch(() => {});
display.stop();
process.exit(0);
