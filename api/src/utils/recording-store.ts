import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.RECORDINGS_DIR || "/data/recordings";

type BufferMap = Map<string, any[]>;
const buffers: BufferMap = new Map();

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

/** Legacy event buffer (rrweb) — kept for API compat, prefer video files. */
export function appendRecordingEvents(sessionId: string, events: any[]): void {
  if (!sessionId || !events?.length) return;
  const buf = buffers.get(sessionId) || [];
  buf.push(...events);
  buffers.set(sessionId, buf);
}

export function flushRecording(sessionId: string): string | null {
  if (!sessionId) return null;
  ensureRoot();
  // Prefer existing video meta written by session recorder
  const metaPath = path.join(ROOT, `${sessionId}.json`);
  if (fs.existsSync(metaPath)) return metaPath;

  const events = buffers.get(sessionId) || [];
  buffers.delete(sessionId);
  if (!events.length) return null;
  const file = path.join(ROOT, `${sessionId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId,
      savedAt: new Date().toISOString(),
      eventCount: events.length,
      events,
    }),
  );
  return file;
}

export function getRecording(sessionId: string): {
  sessionId: string;
  savedAt?: string;
  eventCount?: number;
  frameCount?: number;
  format?: string;
  videoUrl?: string;
  videoPath?: string;
  events?: any[];
} | null {
  ensureRoot();
  const metaPath = path.join(ROOT, `${sessionId}.json`);
  const mp4Path = path.join(ROOT, `${sessionId}.mp4`);

  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (fs.existsSync(mp4Path)) {
        return {
          ...meta,
          format: "mp4",
          videoPath: mp4Path,
          videoUrl: `/v1/sessions/${sessionId}/recording/video`,
        };
      }
      return meta;
    } catch {
      return null;
    }
  }

  if (fs.existsSync(mp4Path)) {
    return {
      sessionId,
      format: "mp4",
      videoPath: mp4Path,
      videoUrl: `/v1/sessions/${sessionId}/recording/video`,
    };
  }

  const live = buffers.get(sessionId);
  if (live?.length) {
    return { sessionId, eventCount: live.length, events: live };
  }
  return null;
}

export function getRecordingVideoPath(sessionId: string): string | null {
  const p = path.join(ROOT, `${sessionId}.mp4`);
  return fs.existsSync(p) ? p : null;
}

export function clearRecordingBuffer(sessionId: string): void {
  buffers.delete(sessionId);
}
