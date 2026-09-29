import fs from "node:fs";
import path from "node:path";

/**
 * Server hygiene: keeps recordings and session history from growing forever.
 *
 * - Recordings (/data/recordings): video + rrweb json older than
 *   RECORDINGS_MAX_AGE_HOURS (default 24h) are deleted on every maintenance
 *   pass.
 * - Past sessions (in-memory list shown in the UI): entries older than
 *   SESSION_HISTORY_MAX_AGE_HOURS (default 24h) are dropped, so the session
 *   list flushes daily too.
 *
 * The maintenance loop runs hourly; with the 24h defaults that means every
 * recording and session entry lives at most ~24h, keeping the memory and disk
 * footprint flat.
 */

const RECORDINGS_ROOT = process.env.RECORDINGS_DIR || "/data/recordings";
const RECORDING_MAX_AGE_MS =
  Math.max(1, parseFloat(process.env.RECORDINGS_MAX_AGE_HOURS || "24")) * 60 * 60 * 1000;
const SESSION_HISTORY_MAX_AGE_MS =
  Math.max(1, parseFloat(process.env.SESSION_HISTORY_MAX_AGE_HOURS || "24")) * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** Deletes recordings (mp4 + json meta) older than the configured max age. */
export function flushOldRecordings(
  root: string = RECORDINGS_ROOT,
  maxAgeMs: number = RECORDING_MAX_AGE_MS,
): { filesRemoved: number; bytesFreed: number } {
  let filesRemoved = 0;
  let bytesFreed = 0;
  try {
    if (!fs.existsSync(root)) return { filesRemoved, bytesFreed };
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".mp4") && !name.endsWith(".json")) continue;
      const file = path.join(root, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) {
          bytesFreed += stat.size;
          fs.unlinkSync(file);
          filesRemoved += 1;
        }
      } catch {
        // file vanished mid-sweep — fine
      }
    }
  } catch {
    // recordings root unreadable — nothing to do
  }
  return { filesRemoved, bytesFreed };
}

/** Drops released sessions older than the configured max age from the UI list. */
export function flushOldSessionHistory(
  pastSessions: Array<{ createdAt?: string }>,
  maxAgeMs: number = SESSION_HISTORY_MAX_AGE_MS,
): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (let i = pastSessions.length - 1; i >= 0; i--) {
    const created = pastSessions[i]?.createdAt ? Date.parse(pastSessions[i].createdAt!) : 0;
    if (!created || created < cutoff) {
      pastSessions.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

/** One maintenance pass over recordings, session history and tmp profiles. */
export function runMaintenancePass(
  pastSessions: Array<{ createdAt?: string }>,
  log: (msg: string) => void,
  sweepProfiles?: () => number,
): void {
  const rec = flushOldRecordings();
  const sessions = flushOldSessionHistory(pastSessions);
  const profiles = sweepProfiles ? sweepProfiles() : 0;
  if (rec.filesRemoved || sessions || profiles) {
    log(
      `[janitor] flushed ${rec.filesRemoved} recording(s) (${(
        rec.bytesFreed / 1024 / 1024
      ).toFixed(1)} MB), ${sessions} old session(s), ${profiles} stale profile(s)`,
    );
  }
}

/** Starts the hourly maintenance loop. Returns a stop function. */
export function startMaintenanceLoop(
  pastSessions: Array<{ createdAt?: string }>,
  log: (msg: string) => void,
  sweepProfiles?: () => number,
): () => void {
  const timer = setInterval(
    () => {
      try {
        runMaintenancePass(pastSessions, log, sweepProfiles);
      } catch (e) {
        log(`[janitor] maintenance pass failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    MAINTENANCE_INTERVAL_MS,
  );
  // Do not keep the process alive just for the janitor.
  timer.unref?.();
  return () => clearInterval(timer);
}
