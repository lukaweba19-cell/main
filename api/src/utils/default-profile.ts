import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The persistent fingerprint identity.
 *
 * A Chromium "fingerprint" is not a random seed the launcher rolls every time —
 * it is the long-lived state in the user-data-dir: fonts, GPU quirks, prefs,
 * cookies, language, window metrics. Regenerating a profile per launch is what
 * made every xreactor check look like a brand-new machine (and made any
 * "remember this choice" pref evaporate).
 *
 * This module owns ONE durable default profile:
 *
 *   /data/steel-profiles/default   (NODE_ENV=production)
 *   <tmpdir>/steel-profiles/default (dev)
 *
 * Isolated xreactor checks CLONE it (cp -a) into a temp dir per check, so:
 *   - every check starts from the same fingerprint + the same
 *     "always allow / never ask" preferences (popup stays fixed),
 *   - checks still cannot pollute the durable profile,
 *   - the clone is deleted with the check's browser.
 */

const PROFILE_BASE_ENV = "STEEL_PROFILE_BASE";

/** Root directory that holds the durable default profile. */
export function defaultProfileBase(): string {
  if (process.env[PROFILE_BASE_ENV]) return process.env[PROFILE_BASE_ENV];
  if (process.env.NODE_ENV === "development") {
    return path.join(os.tmpdir(), "steel-profiles");
  }
  return "/data/steel-profiles";
}

export function defaultProfileDir(): string {
  return path.join(defaultProfileBase(), "default");
}

/**
 * Ensure the durable default profile exists. When brand new, seed it with the
 * external-protocol handling that kills the "Open xdg-open?" dialog for good
 * (see seedExternalProtocolPrefs — modern Chromium reads the per-origin
 * allow-list from the plain Preferences file; the old Secure-Preferences
 * seeding never worked because those keys are HMAC-tracked and reset).
 */
export function ensureDefaultProfile(): string {
  const dir = defaultProfileDir();
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  const prefsPath = path.join(dir, "Default", "Preferences");

  if (!fs.existsSync(prefsPath)) {
    // First run: nothing to preserve, seed everything.
    writeExternalProtocolPrefs(dir, {});
    fs.writeFileSync(
      path.join(dir, "First Run"),
      "",
    );
  }
  return dir;
}

/**
 * The pref Chromium's external_protocol_handler consults BEFORE showing the
 * "Open xdg-open?" dialog: protocol_handler.allowed_origin_protocol_pairs —
 * {"https://t.me": {"tg": true}} is exactly what clicking the checkbox "Always
 * allow" persists. We seed a wildcard-ish allow for the protocol LaunchUrl
 * path so NO origin ever gets the modal.
 *
 * Additionally `protocol_handler.allow_excluded_schemes: false` +
 * `excluded_schemes` are kept for older binaries; unknown keys are ignored by
 * newer Chromium, so both shapes can live side by side safely.
 */
export const SUPPRESSED_PROTOCOL_SCHEMES = [
  "tg",
  "whatsapp",
  "viber",
  "skype",
  "slack",
  "zoommtg",
  "ms-windows-store",
  "discord",
  "webcal",
  "steam",
  "spotify",
  "mailto",
  "msteams",
  "zoomus",
  "tel",
  "sms",
] as const;

/**
 * Write/merge the external-protocol prefs into a profile dir's
 * Default/Preferences. `extraOriginPairs` lets callers allow-list specific
 * origins ({"https://t.me": {"tg": true}}).
 */
export function writeExternalProtocolPrefs(
  profileDir: string,
  extraOriginPairs: Record<string, Record<string, boolean>>,
): void {
  try {
    const defaultDir = path.join(profileDir, "Default");
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, "Preferences");

    let prefs: Record<string, any> = {};
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    } catch {
      // no existing prefs — fresh profile
    }

    const excluded: Record<string, boolean> = {};
    for (const scheme of SUPPRESSED_PROTOCOL_SCHEMES) excluded[scheme] = true;

    const originPairs: Record<string, Record<string, boolean>> = {
      ...(prefs.protocol_handler?.allowed_origin_protocol_pairs ?? {}),
      ...extraOriginPairs,
    };
    // The dialog only ever fires from web content; allowing every plausible
    // web origin for the suppressed schemes means GetBlockState() returns
    // DONT_BLOCK before RunExternalProtocolDialog() can appear.
    for (const origin of [
      "https://t.me",
      "http://t.me",
      "https://telegram.me",
      "https://web.telegram.org",
      "https://whatsapp.com",
      "https://wa.me",
      "https://viber.com",
      "https://discord.com",
      "https://slack.com",
      "https://zoom.us",
      "https://skype.com",
    ]) {
      const map: Record<string, boolean> = {};
      for (const scheme of SUPPRESSED_PROTOCOL_SCHEMES) map[scheme] = true;
      originPairs[origin] = { ...(originPairs[origin] ?? {}), ...map };
    }

    prefs.protocol_handler = {
      ...(prefs.protocol_handler ?? {}),
      allow_excluded_schemes: false,
      excluded_schemes: excluded,
      allowed_origin_protocol_pairs: originPairs,
    };
    // Kill the credential-leak + restore bubbles while we are in here.
    prefs.credentials_enable_service = false;
    prefs.credentials_enable_autosignin = false;
    prefs.distribution = { ...(prefs.distribution ?? {}), import_bookmarks: false };

    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch {
    // Preferences seeding is best-effort; the xdg-open shim and the OS policy
    // files (installed by setup.sh) are the backstops.
  }
}

/**
 * Clone the durable default profile into a fresh temp dir for an isolated
 * check. Returns the clone path (caller deletes it with the browser).
 */
export function cloneDefaultProfile(log?: (msg: string) => void): string {
  const source = ensureDefaultProfile();
  const clone = path.join(os.tmpdir(), `xreactor-profile-${randomUUID()}`);
  fs.mkdirSync(clone, { recursive: true });
  try {
    // cp -a preserves mtimes/symlinks; a profile is just files.
    fs.cpSync(source, clone, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    log?.(`[profiles] clone of default profile failed (${err}); using fresh profile`);
  }
  return clone;
}
