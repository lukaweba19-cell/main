import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = process.env.RECORDINGS_DIR || "/data/recordings";
const DISPLAY = process.env.DISPLAY || ":10";

export type SessionRecorder = {
  sessionId: string;
  stop: () => Promise<string | null>;
};

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

/**
 * Full continuous video of the browser via ffmpeg x11grab on Xvfb.
 * Real H.264 MP4 — no page injection.
 */
export async function startSessionRecorder(
  _page: unknown,
  sessionId: string,
): Promise<SessionRecorder | null> {
  if (!sessionId) return null;
  ensureRoot();

  const outFile = path.join(ROOT, `${sessionId}.mp4`);
  const metaPath = path.join(ROOT, `${sessionId}.json`);
  try {
    fs.unlinkSync(outFile);
  } catch {}

  let proc: ChildProcess | null = null;
  let stopped = false;

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
        "1920x1080",
        "-framerate",
        "10",
        "-i",
        `${DISPLAY}.0`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "28",
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

  const stop = async (): Promise<string | null> => {
    if (stopped) return null;
    stopped = true;

    if (child) {
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
    }

    await new Promise((r) => setTimeout(r, 300));

    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) {
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
