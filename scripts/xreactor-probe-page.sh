#!/usr/bin/env bash
# Probe what the isolated browser actually sees on a t.me page: anchor count,
# harvested links, innerText. Uses the built API bundle with the same launch
# path as production checks (same stealth args, same Xvfb pattern).
set -uo pipefail
cd /root/steel-browser/api
cat > /tmp/probe-tme.mjs <<'JS'
import { chromium } from "patchright";
import { resolveBrowser, getCloakStealthArgs } from "./build/utils/resolve-browser.js";
import { getExtensionPaths } from "./build/utils/extensions.js";
import fs from "node:fs";
import os from "os";
import path from "node:path";

const target = process.argv[2] || "https://t.me/cracxAds";
const resolved = resolveBrowser();
const profileDir = path.join(os.tmpdir(), `probe-profile-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
fs.writeFileSync(
  path.join(profileDir, "Default", "Preferences"),
  JSON.stringify({
    protocol_handler: {
      excluded_schemes: { tg: 1, whatsapp: 1, viber: 1, skype: 1, mailto: 1, discord: 1 },
    },
  }),
);
const ext = await getExtensionPaths();
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  executablePath: resolved.executablePath,
  viewport: { width: 1440, height: 900 },
  args: [
    ...getCloakStealthArgs(),
    "--test-type",
    "--disable-dev-shm-usage",
    ...(ext.length ? [`--load-extension=${ext.join(",")}`, `--disable-extensions-except=${ext.join(",")}`] : []),
  ],
  env: { ...process.env, DISPLAY: process.env.PROBE_DISPLAY || ":20" },
  timeout: 45000,
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("goto-err:", e.message));
await page.waitForTimeout(5000);
const info = await page.evaluate(() => ({
  title: document.title,
  anchors: Array.from(document.links).map((a) => a.href).slice(0, 30),
  text: (document.body?.innerText || "").slice(0, 600),
}));
console.log("title:", info.title);
console.log("anchors:", JSON.stringify(info.anchors, null, 1));
console.log("text-head:", info.text.replace(/\n+/g, " | ").slice(0, 500));
await ctx.close().catch(() => {});
process.exit(0);
JS
PROBE_DISPLAY=:20 node /tmp/probe-tme.mjs "${1:-https://t.me/cracxAds}" 2>&1 | grep -vi warning | head -50
pkill -f "Xvfb :20" 2>/dev/null || true
rm -rf /tmp/probe-profile-* 2>/dev/null || true
