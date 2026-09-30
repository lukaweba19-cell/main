// Bisect probe: replicate the SESSION-path launch (nodriver sidecar + CDP
// attach) and toggle the suspects — profile (default vs fresh) and extensions.
// Env toggles: PROFILE=default|fresh  EXT=0|1
// Display is acquired via the production allocator (concurrency-safe).
import { chromium } from "patchright";
import { resolveBrowser } from "./build/utils/resolve-browser.js";
import { acquireXvfbDisplay } from "./build/modules/xreactor/xvfb-display.js";
import { nodriverLaunch } from "./build/utils/nodriver-client.js";
import { getExtensionPaths } from "./build/utils/extensions.js";
import { cloneDefaultProfile } from "./build/utils/default-profile.js";
import fs from "node:fs";
import os from "os";
import path from "node:path";

const PROFILE = process.env.PROFILE || "default";
const EXT = process.env.EXT === "1";
const TARGET = process.env.TARGET || "https://pulsetic.com/";

const resolved = resolveBrowser();
const display = await acquireXvfbDisplay();
console.log(`[bisect] PROFILE=${PROFILE} EXT=${EXT ? 1 : 0} TARGET=${TARGET} display=${display.display}`);

let profileDir;
if (PROFILE === "default") {
  profileDir = "/data/steel-profiles/default";
} else {
  profileDir = cloneDefaultProfile((m) => console.log("[bisect]", m));
}
console.log("[bisect] profile:", profileDir);

const extensionPaths = EXT ? await getExtensionPaths() : [];
console.log("[bisect] extensions:", extensionPaths.length);

let launch;
try {
  launch = await nodriverLaunch(
    {
      profile: profileDir,
      port: 0,
      display: display.display,
      window: [1920, 1080],
      executable: resolved.executablePath,
      extensions: extensionPaths,
      cfVerify: false,
    },
    90_000,
  );
} catch (e) {
  console.log("[bisect] LAUNCH FAILED:", String(e?.message || e).slice(0, 200));
  display.stop();
  process.exit(2);
}
if (!launch.ok || !launch.webSocketDebuggerUrl) {
  console.log("[bisect] sidecar launch not ok:", launch.error || "no ws url");
  display.stop();
  process.exit(2);
}
console.log(
  `[bisect] sidecar launch ok pid=${launch.pid} port=${launch.port} ext=${(launch.extensionsLoaded ?? []).length}/${(launch.extensionsFailed ?? []).length}`,
);

const browser = await chromium.connectOverCDP(launch.webSocketDebuggerUrl);
const context = browser.contexts()[0];
const page = context.pages()[0] || (await context.newPage());

const t0 = Date.now();
const timeline = [];
page.on("response", (r) => {
  const req = r.request();
  if (req.resourceType() === "document" && req.frame() === page.mainFrame())
    timeline.push(`${Date.now() - t0}ms response ${r.status()} ${r.url().slice(0, 80)}`);
});
page.on("requestfailed", (r) => {
  if (r.resourceType() === "document" && r.frame() === page.mainFrame())
    timeline.push(`${Date.now() - t0}ms FAILED ${r.failure()?.errorText} ${r.url().slice(0, 80)}`);
});
page.on("domcontentloaded", () => timeline.push(`${Date.now() - t0}ms *** DCL ***`));

let gotoMs = -1;
let gotoErr = null;
try {
  const t = Date.now();
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30000 });
  gotoMs = Date.now() - t;
} catch (e) {
  gotoErr = String(e?.message || e).split("\n")[0];
}
console.log(`[bisect] goto: ${gotoErr ? "ERROR " + gotoErr : "OK " + gotoMs + "ms"}`);

const state = await page
  .evaluate(() => ({
    url: location.href,
    rs: document.readyState,
    chars: (document.body?.innerText || "").trim().length,
    nodes: document.body ? document.body.querySelectorAll("*").length : 0,
  }))
  .catch((e) => ({ evalErr: String(e?.message || e).slice(0, 100) }));
console.log("[bisect] page state:", JSON.stringify(state));
for (const line of timeline) console.log("   ", line);

await browser.close().catch(() => {});
display.stop();
if (PROFILE !== "default" && profileDir.startsWith("/tmp")) {
  fs.rm(profileDir, { recursive: true, force: true }, () => {});
}
process.exit(0);
