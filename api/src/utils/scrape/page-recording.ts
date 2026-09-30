import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";

const ROOT = process.env.RECORDINGS_DIR || "/data/recordings";
const DISPLAY = process.env.DISPLAY || ":10";

/**
 * Registry of every ffmpeg recorder this process started (keyed by pid).
 * Lets the janitor/reaper kill x11grab processes that outlived their session
 * (a scrape that threw before stopRecording used to leak its encoder forever —
 * two orphans were chewing ~70% of a CPU core on the 3-core VM).
 */
const liveRecorders = new Map<number, { pid: number; outFile: string; startedAt: number }>();

export function getLiveRecorders(): Array<{ pid: number; outFile: string; startedAt: number }> {
  return Array.from(liveRecorders.values());
}

/**
 * Kills ffmpeg x11grab processes that are NOT in the live registry (orphans
 * from previous runs/crashes). Returns how many were killed. Runs on startup
 * and on every maintenance pass.
 */
export async function reapOrphanRecorders(): Promise<number> {
  const pids = await new Promise<number[]>((resolve) => {
    execFile("pgrep", ["-f", "ffmpeg.*x11grab"], (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        stdout
          .split("\n")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
    });
  });
  let killed = 0;
  for (const pid of pids) {
    if (liveRecorders.has(pid)) continue; // ours and tracked — legit
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // already gone
    }
  }
  return killed;
}

export type SessionRecorder = {
  sessionId: string;
  stop: () => Promise<string | null>;
};

export interface SessionRecorderOptions {
  /** X11 display to grab (":10", ":12", ...). Defaults to the shared DISPLAY env. */
  display?: string;
  /** Grab area — should match the browser window size on that display. */
  width?: number;
  height?: number;
}

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

/**
 * Full continuous video of the browser via ffmpeg x11grab. Real H.264 MP4 —
 * no page injection. The file lands in RECORDINGS_DIR and is exposed at
 * /v1/sessions/:id/recording/video.
 *
 * With no options it grabs the shared DISPLAY at 1920x1080 (the classic
 * single-browser behavior). Isolated check browsers pass their own dedicated
 * Xvfb display + window size so concurrent sessions each get a private,
 * correctly-framed recording.
 */
export async function startSessionRecorder(
  _page: unknown,
  sessionId: string,
  opts: SessionRecorderOptions = {},
): Promise<SessionRecorder | null> {
  if (!sessionId) return null;
  ensureRoot();

  const display = opts.display || DISPLAY;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const outFile = path.join(ROOT, `${sessionId}.mp4`);
  const metaPath = path.join(ROOT, `${sessionId}.json`);
  try {
    fs.unlinkSync(outFile);
  } catch {}
  try {
    fs.unlinkSync(metaPath);
  } catch {}

  let proc: ChildProcess | null = null;

  try {
    proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        "10",
        "-i",
        `${display}.0`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "28",
        "-movflags",
        "+faststart",
        "-an",
        outFile,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    console.warn("[recorder] failed to start ffmpeg", err);
    return null;
  }

  const child = proc;

  // Register for orphan-reaping; deregister on exit.
  if (child.pid) {
    liveRecorders.set(child.pid, { pid: child.pid, outFile, startedAt: Date.now() });
    child.on("exit", () => liveRecorders.delete(child.pid!));
  }

  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  child.on("error", (err) => {
    console.warn("[recorder] ffmpeg process error", err);
  });

  const stop = async (): Promise<string | null> => {
    if (child.exitCode !== null || !child.pid) {
      // already exited
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      child.once("close", finish);
      try {
        child.kill("SIGINT");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      }, 4000);
    });

    await new Promise((r) => setTimeout(r, 300));

    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) {
      if (stderrTail) {
        console.warn(`[recorder] ffmpeg output invalid for ${sessionId}: ${stderrTail}`);
      }
      try {
        fs.unlinkSync(outFile);
      } catch {}
      return null;
    }

    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        sessionId,
        savedAt: new Date().toISOString(),
        format: "mp4",
        video: `${sessionId}.mp4`,
        videoUrl: `/v1/sessions/${sessionId}/recording/video`,
        sizeBytes: fs.statSync(outFile).size,
      }),
    );
    return outFile;
  };

  return { sessionId, stop };
}
