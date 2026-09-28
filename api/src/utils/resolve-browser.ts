import fs from "fs";
import os from "os";
import path from "path";

/**
 * CloakBrowser-only browser resolution.
 *
 * This deployment launches exclusively the CloakBrowser stealth Chromium
 * (github.com/CloakHQ/cloakbrowser) — a Chromium build with fingerprint
 * patches compiled in at the C++ source level. Stock Chrome/Chromium is not
 * supported and never resolved; if no CloakBrowser binary exists the launch
 * fails with instructions instead of silently falling back.
 *
 * Priority:
 *   1. CLOAKBROWSER_BINARY_PATH / CLOAKBROWSER_EXECUTABLE_PATH (explicit override)
 *   2. ~/.cloakbrowser/chromium-<version>/chrome (what `npx cloakbrowser install`
 *      downloads; highest version wins, -pro builds preferred when licensed)
 */

const CLOAK_STEALTH_ARGS = ["--no-sandbox", "--fingerprint-platform=linux"] as const;

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

export class BrowserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserNotFoundError";
  }
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
 * The stealth args the launcher passes to the CloakBrowser binary on Linux:
 * --no-sandbox, --fingerprint=<random 5-digit seed>, --fingerprint-platform=linux.
 * The fingerprint seed is generated per launch.
 */
export function getCloakStealthArgs(): string[] {
  return [`--fingerprint=${fingerprintSeed()}`, ...CLOAK_STEALTH_ARGS];
}

/**
 * Resolve the CloakBrowser binary to launch. Throws BrowserNotFoundError when
 * none is installed — there is deliberately no Chrome/Chromium fallback.
 */
export function resolveBrowser(): ResolvedBrowser {
  // 1. Explicit override always wins.
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
    throw new BrowserNotFoundError(
      `CLOAKBROWSER_BINARY_PATH=${executablePath} does not exist`,
    );
  }

  // 2. Auto-detected CloakBrowser cache (~/.cloakbrowser).
  const cacheDir =
    process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), ".cloakbrowser");
  const cloak = findCloakBinaryInCache(cacheDir);
  if (cloak) return cloak;

  throw new BrowserNotFoundError(
    `CloakBrowser binary not found (looked in ${cacheDir}). ` +
      `Install it with: npx cloakbrowser install`,
  );
}
