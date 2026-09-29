import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "node:child_process";

/**
 * Browser resolution for the nodriver stack.
 *
 * CloakBrowser is GONE. The engine is now: nodriver (Python) launching stock
 * Chrome/Chromium with its own stealth defaults; this module only finds the
 * binary to hand to it. No fingerprint flags exist any more — fingerprint
 * persistence comes from reusing ONE user-data-dir (see default-profile.ts),
 * which is the honest way to keep an identity stable across launches.
 *
 * Priority:
 *   1. CHROME_EXECUTABLE_PATH (explicit)
 *   2. google-chrome / google-chrome-stable / chromium / chromium-browser on PATH
 *   3. Common install locations (/usr/bin, /opt/google/chrome)
 */

export interface ResolvedBrowser {
  /** Absolute path to the browser executable to launch. */
  executablePath: string;
  /** Which engine the path came from. */
  engine: "chrome";
  /** `--version` output when detectable. */
  version?: string;
}

export class BrowserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserNotFoundError";
  }
}

const CANDIDATE_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "google-chrome-beta",
  "chromium",
  "chromium-browser",
];

const CANDIDATE_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  "/opt/google/chrome/google-chrome",
  // Puppeteer-style downloads kept out of the way of apt
  "/root/.cache/puppeteer/chrome/*/chrome-linux64/chrome",
];

function versionOf(binaryPath: string): string | undefined {
  try {
    return execFileSync(binaryPath, ["--version"], { timeout: 5_000 })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Chrome/Chromium binary that nodriver will launch. Throws
 * BrowserNotFoundError when none is installed.
 */
export function resolveBrowser(): ResolvedBrowser {
  // 1. Explicit override always wins.
  const override = process.env.CHROME_EXECUTABLE_PATH;
  if (override) {
    const executablePath = path.normalize(override);
    if (fs.existsSync(executablePath)) {
      return { executablePath, engine: "chrome", version: versionOf(executablePath) };
    }
    throw new BrowserNotFoundError(`CHROME_EXECUTABLE_PATH=${executablePath} does not exist`);
  }

  // 2. PATH lookup (what apt / snap installs provide).
  for (const name of CANDIDATE_NAMES) {
    const dirs = (process.env.PATH || "").split(path.delimiter);
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { executablePath: candidate, engine: "chrome", version: versionOf(candidate) };
      } catch {
        // keep looking
      }
    }
  }

  // 3. Known install locations.
  for (const candidate of CANDIDATE_PATHS) {
    if (candidate.includes("*")) {
      // glob-ish: expand the wildcard segment manually
      const [prefix, suffix] = candidate.split("*");
      const parent = path.dirname(prefix);
      try {
        if (!fs.existsSync(parent)) continue;
        const entries = fs
          .readdirSync(parent)
          .filter((name) => name.startsWith(path.basename(prefix)))
          .sort()
          .reverse();
        for (const entry of entries) {
          const full = path.join(parent, entry, suffix);
          try {
            fs.accessSync(full, fs.constants.X_OK);
            return { executablePath: full, engine: "chrome", version: versionOf(full) };
          } catch {
            // next entry
          }
        }
      } catch {
        // unreadable dir — keep going
      }
      continue;
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { executablePath: candidate, engine: "chrome", version: versionOf(candidate) };
    } catch {
      // keep looking
    }
  }

  throw new BrowserNotFoundError(
    "Chrome/Chromium binary not found. Install it with: " +
      "`npx @puppeteer/browsers install chrome@stable` or `apt-get install -y chromium`, " +
      "or set CHROME_EXECUTABLE_PATH.",
  );
}

/** Home directory of the account running the API (root on the VM). */
export function homeDir(): string {
  return os.homedir();
}
