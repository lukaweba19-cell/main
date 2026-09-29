import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "os";
import path from "node:path";

/**
 * Dedicated Xvfb display per concurrent xreactor check.
 *
 * The shared Steel display (:10) is a single 1920x1080 screen — recording it
 * with x11grab films EVERY browser at once and a 1440x900 window floats
 * somewhere in the middle of the frame. Concurrency requires each check to
 * run on its own virtual screen:
 *
 *   Xvfb :N -screen 0 1440x950x24   (small screen => video IS the window)
 *     -> Chromium DISPLAY=:N        (window sized to fill the screen)
 *     -> ffmpeg x11grab :N          (records exactly that check's browser)
 *     -> kill Xvfb when the check finishes
 *
 * Display numbers are allocated starting after the shared base display so we
 * never collide with :10 itself.
 */

const BASE_DISPLAY_NUM = (() => {
  const envDisplay = process.env.DISPLAY || ":10";
  const n = parseInt(envDisplay.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

const XVFB_BIN = process.env.XVFB_PATH || "Xvfb";

export interface XvfbDisplay {
  /** Display string for env/DISPLAY, e.g. ":12". */
  display: string;
  /** Screen size to use for browser window + ffmpeg grab. */
  width: number;
  height: number;
  stop: () => void;
}

let nextDisplay = BASE_DISPLAY_NUM + 1;

function lockPath(n: number): string {
  return `/tmp/.X${n}-lock`;
}

function socketPath(n: number): string {
  return `/tmp/.X11-unix/X${n}`;
}

/** True when no X server currently owns display :n. */
function displayFree(n: number): boolean {
  try {
    fs.statSync(lockPath(n));
    return false;
  } catch {}
  try {
    fs.statSync(socketPath(n));
    return false;
  } catch {}
  return true;
}

/**
 * Spawns a private Xvfb server for one check. Throws when Xvfb is missing —
 * callers fall back to the shared display so checks never break because of
 * recording infrastructure.
 */
export async function acquireXvfbDisplay(): Promise<XvfbDisplay | null> {
  if (os.platform() !== "linux") return null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const n = nextDisplay;
    nextDisplay = nextDisplay >= BASE_DISPLAY_NUM + 64 ? BASE_DISPLAY_NUM + 1 : nextDisplay + 1;
    if (!displayFree(n)) continue;

    // Viewport is 1440x900; the screen gets a small margin so the window
    // manager decorations (title bar) still fit inside the grab area.
    const width = 1440;
    const height = 950;

    let proc: ChildProcess;
    try {
      proc = spawn(
        XVFB_BIN,
        [":"+n, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"],
        { stdio: ["ignore", "ignore", "pipe"], detached: false },
      );
    } catch {
      return null; // Xvfb binary missing
    }

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      proc.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(false);
        void code;
      });
      // The display socket appearing means the server is up.
      const poll = setInterval(() => {
        try {
          fs.statSync(socketPath(n));
          clearInterval(poll);
          clearTimeout(timer);
          resolve(true);
        } catch {
          // not ready yet
        }
      }, 50);
    });

    if (!ready) {
      try {
        proc.kill("SIGKILL");
      } catch {}
      continue; // e.g. display raced busy — try the next number
    }

    let stopped = false;
    return {
      display: ":" + n,
      width,
      height,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          proc.kill("SIGKILL");
        } catch {}
        try {
          fs.rmSync(lockPath(n), { force: true });
        } catch {}
        try {
          fs.rmSync(socketPath(n), { force: true });
        } catch {}
      },
    };
  }
  return null;
}
