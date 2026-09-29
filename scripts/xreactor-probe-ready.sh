#!/usr/bin/env bash
# Probe: run a t.me page in an isolated browser and print readiness snapshots
# every 600ms so the ready-loop behavior can be seen/tuned directly.
set -uo pipefail
cd /root/steel-browser/api
cat > /tmp/probe2.mjs <<'JS'
import { chromium } from "patchright";
import { resolveBrowser, getCloakStealthArgs } from "./build/utils/resolve-browser.js";
import fs from "node:fs"; import os from "os"; import path from "node:path";
const resolved = resolveBrowser();
const profileDir = path.join(os.tmpdir(), "probe2-" + Date.now());
fs.mkdirSync(profileDir + "/Default", { recursive: true });
const excluded = {}; for (const s of ["tg","whatsapp","viber","skype","slack","zoommtg","ms-windows-store","discord","mailto","webcal","steam","spotify"]) excluded[s] = true;
const prefs = { protocol_handler: { allow_excluded_schemes: false, excluded_schemes: excluded } };
fs.writeFileSync(profileDir + "/Default/Preferences", JSON.stringify(prefs));
fs.writeFileSync(profileDir + "/Default/Secure Preferences", JSON.stringify({ protocol_handler: { allow_excluded_schemes: false, excluded_schemes: excluded } }));
const t0 = Date.now();
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false, executablePath: resolved.executablePath,
  args: [...getCloakStealthArgs(), "--test-type", "--disable-dev-shm-usage"],
  env: { ...process.env, DISPLAY: process.env.PROBE_DISPLAY || ":21" }, timeout: 45000,
});
console.log("launchMs:", Date.now() - t0);
const page = ctx.pages()[0] || await ctx.newPage();
const t1 = Date.now();
await page.goto(process.argv[2] || "https://t.me/cracxAds", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => console.log("goto-err:", e.message.slice(0, 120)));
console.log("navMs:", Date.now() - t1);
await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
console.log("after-load ms:", Date.now() - t1);
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(600);
  const snap = await page.evaluate(() => ({
    title: document.title,
    chars: (document.body?.innerText || "").length,
    tags: document.querySelectorAll("a, p, h1, h2, h3, li, td, th, article, section").length,
    rs: document.readyState,
    urls: (document.body?.innerText || "").match(/https?:\/\/[^\s<>()]+/g)?.slice(0, 5) || [],
  })).catch(e => null);
  console.log("t=" + (Date.now() - t1) + "ms", JSON.stringify(snap));
  if (i >= 9) break;
}
await ctx.close().catch(() => {}); process.exit(0);
JS
node /tmp/probe2.mjs "${1:-https://t.me/cracxAds}" 2>&1 | grep -vi warning | head -26
pkill -f "Xvfb :21" 2>/dev/null || true
rm -rf /tmp/probe2-* 2>/dev/null || true
