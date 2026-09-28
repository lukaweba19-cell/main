import fs from "fs";
import os from "os";
import path from "path";

/**
 * Browser engine resolution with CloakBrowser support.
 *
 * CloakBrowser (github.com/CloakHQ/cloakbrowser) is a Chromium binary with
 * source-level (C++) fingerprint patches — 58 patches on the free Linux build.
 * When its binary is present we prefer it over stock Chrome and add the same
 * stealth arguments the official cloakbrowser JS wrapper would pass
 * (--fingerprint=<seed>, --fingerprint-platform=windows), because those flags
 * drive the C++-patched code paths inside the binary.
 *
 * Priority:
 *   1. CLOAKBROWSER_BINARY_PATH / CLOAKBROWSER_EXECUTABLE_PATH (explicit override)
 *   2. ~/.cloakbrowser/chromium-<version>/chrome  (what `npx cloakbrowser install`
 *      downloads; picks the highest version, prefers -pro builds when licensed)
 *   3. CHROME_EXECUTABLE_PATH (existing behaviour)
 *   4. Platform Chrome locations (google-chrome, chromium, ...)
 *
 * Disable entirely with STEEL_DISABLE_CLOAKBROWSER=true.
 */

const CLOAK_STEALTH_ARGS = ["--no-sandbox", "--fingerprint-platform=windows"] as const;

export interface ResolvedBrowser {
  /** Absolute path to the browser executable to launch. */
  executablePath: string;
  /** Which engine the path came from. */
  engine: "cloakbrowser" | "chrome";
  /** Version string when detectable (CloakBrowser dir name, `google-chrome --version`). */
  version?: string;
  /** True when engine === "cloakbrowser": launch must add the cloak stealth args. */
  stealthArgs: string[];
}

/** A random 5-digit fingerprint seed, matching the official wrapper's behaviour. */
function fingerprintSeed(): string {
  return String(Math.floor(Math.random() * 90000) + 10000);
}

function readVersionFromMarker(cacheDir: string): string | null {
  // The wrapper writes latest_version_<platform> markers on install/update.
  const markerNames = ["latest_version_linux-x64", "latest_version"];
  for (const name of markerNames) {
    try {
      const marker = path.join(cacheDir, name);
      if (fs.existsSync(marker)) {
        const version = fs.readFileSync(marker, "utf-8").trim();
        if (version) return version;
      }
    } catch {
      // unreadable marker — fall through to directory scan
    }
  }
  return null;
}

function hasProLicense(cacheDir: string): boolean {
  return (
    fs.existsSync(path.join(cacheDir, "license.key")) ||
    !!process.env.CLOAKBROWSER_LICENSE_KEY
  );
}

function findCloakBinaryInCache(cacheDir: string): ResolvedBrowser | null {
  if (!fs.existsSync(cacheDir)) return null;

  const markerVersion = readVersionFromMarker(cacheDir);
  const pro = hasProLicense(cacheDir);

  // Candidate versions: marker first, then every chromium-* dir on disk
  // (highest version wins — avoids breaking when markers are stale).
  const candidates: string[] = [];
  if (markerVersion) candidates.push(markerVersion);
  try {
    const entries = fs
      .readdirSync(cacheDir)
      .filter((name) => name.startsWith("chromium-"))
      .sort((a, b) => b.localeCompare(a));
    for (const entry of entries) {
      const version = entry.replace(/^chromium-/, "").replace(/-pro$/, "");
      if (!candidates.includes(version)) candidates.push(version);
    }
  } catch {
    return null;
  }

  for (const version of candidates) {
    // Prefer pro binary when licensed, else free; fall back to whichever exists.
    const order = pro
      ? [
          path.join(cacheDir, `chromium-${version}-pro`, "chrome"),
          path.join(cacheDir, `chromium-${version}`, "chrome"),
        ]
      : [
          path.join(cacheDir, `chromium-${version}`, "chrome"),
          path.join(cacheDir, `chromium-${version}-pro`, "chrome"),
        ];
    for (const binaryPath of order) {
      try {
        if (fs.existsSync(binaryPath)) {
          fs.accessSync(binaryPath, fs.constants.X_OK);
          return {
            executablePath: binaryPath,
            engine: "cloakbrowser",
            version,
            // --no-sandbox is already handled by the launcher for root; the
            // seed arg is added at launch time (see getCloakStealthArgs).
            stealthArgs: [],
          };
        }
      } catch {
        // not executable — try next candidate
      }
    }
  }
  return null;
}

/**
 * The stealth args the official cloakbrowser wrapper passes on Linux:
 * --no-sandbox, --fingerprint=<random 5-digit seed>, --fingerprint-platform=windows.
 * The launcher merges these; the fingerprint seed is generated per launch.
 */
export function getCloakStealthArgs(): string[] {
  return [`--fingerprint=${fingerprintSeed()}`, ...CLOAK_STEALTH_ARGS];
}

/**
 * Resolve which browser binary to launch and whether it needs cloak stealth args.
 */
export function resolveBrowser(): ResolvedBrowser {
  // 1. Explicit overrides always win.
  const override =
    process.env.CLOAKBROWSER_BINARY_PATH || process.env.CLOAKBROWSER_EXECUTABLE_PATH;
  if (override) {
    const executablePath = path.normalize(override);
    if (fs.existsSync(executablePath)) {
      return {
        executablePath,
        engine: "cloakbrowser",
        version: "override",
        stealthArgs: [],
      };
    }
    console.warn(
      `[browser] CLOAKBROWSER_BINARY_PATH=${executablePath} does not exist — falling back`,
    );
  }

  // 2. Auto-detected CloakBrowser cache (~/.cloakbrowser), unless disabled.
  if (process.env.STEEL_DISABLE_CLOAKBROWSER !== "true") {
    const cacheDir =
      process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), ".cloakbrowser");
    const cloak = findCloakBinaryInCache(cacheDir);
    if (cloak) return cloak;
  }

  // 3/4. Existing behaviour: CHROME_EXECUTABLE_PATH then platform locations.
  // Read from process.env (not the frozen zod env) so runtime overrides work.
  const configuredPath = process.env.CHROME_EXECUTABLE_PATH;
  if (configuredPath) {
    const executablePath = path.normalize(configuredPath);
    if (fs.existsSync(executablePath)) {
      return { executablePath, engine: "chrome", stealthArgs: [] };
    }
    console.warn(`Your custom chrome executable at ${executablePath} does not exist`);
  }

  const platformPaths: string[] = [];
  if (process.platform === "win32") {
    platformPaths.push(
      `${process.env["ProgramFiles"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe`,
    );
  } else if (process.platform === "darwin") {
    platformPaths.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    platformPaths.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  for (const candidate of platformPaths) {
    if (fs.existsSync(candidate)) {
      return { executablePath: candidate, engine: "chrome", stealthArgs: [] };
    }
  }

  // Final fallback: patchright's own Chromium build.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require("patchright");
    return { executablePath: chromium.executablePath(), engine: "chrome", stealthArgs: [] };
  } catch {
    return { executablePath: "/usr/bin/chromium", engine: "chrome", stealthArgs: [] };
  }
}
