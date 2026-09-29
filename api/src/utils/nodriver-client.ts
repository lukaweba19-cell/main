import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Node client for the nodriver Python sidecar (api/python/nodriver_launcher.py).
 *
 * Architecture: Python/nodriver OWNS the browser process (stealth launch flags,
 * no webdriver, CDP-flattened sessions — the point of the migration); Node
 * attaches to it over the standard CDP websocket with patchright's
 * connectOverCDP and keeps every Steel pipeline (sessions, recordings,
 * page-events) unchanged.
 *
 * The sidecar is a long-lived child process; each /launch asks it to start one
 * Chrome against a specific profile dir + X display, and returns the CDP
 * websocket URL to attach to.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface NodriverLaunchRequest {
  /** Chrome user-data-dir. Reusing one dir = persistent fingerprint + prefs. */
  profile: string;
  /** Desired --remote-debugging-port. */
  port: number;
  /** X display for this headful browser (e.g. ":11" for an isolated check). */
  display?: string;
  /** [width, height] of the browser window. */
  window?: [number, number];
  /** Explicit chrome binary; defaults to env.CHROME_EXECUTABLE_PATH. */
  executable?: string;
  /** Unpacked extension directories to load. */
  extensions?: string[];
  /** Extra chromium args appended after the launcher's defaults. */
  browserArgs?: string[];
  /** Navigator language. */
  lang?: string;
  /** Per-launch environment vars (TZ, DISPLAY override) applied by the sidecar. */
  env?: Record<string, string>;
  /** Run nodriver-cf-verify on the seed tab right after launch. */
  cfVerify?: boolean;
}

export interface NodriverLaunchResult {
  ok: boolean;
  webSocketDebuggerUrl?: string;
  pid?: number;
  port?: number;
  error?: string;
}

function sidecarPort(): number {
  return parseInt(process.env.NODRIVER_SIDECAR_PORT || "9224", 10) || 9224;
}

function sidecarScript(): string {
  // build/ -> build/python/nodriver_launcher.py (copied by the api build)
  const candidates = [
    path.resolve(__dirname, "python", "nodriver_launcher.py"),
    path.resolve(__dirname, "..", "python", "nodriver_launcher.py"),
    path.resolve(__dirname, "..", "..", "python", "nodriver_launcher.py"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function venvPython(): string {
  const candidates = [
    process.env.NODRIVER_PYTHON,
    path.resolve(__dirname, "..", "..", "python", ".venv", "bin", "python"),
    path.resolve(__dirname, "..", "python", ".venv", "bin", "python"),
    "/root/steel-browser/api/python/.venv/bin/python",
    "python3",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "python3";
}

let sidecarProcess: ChildProcess | null = null;
let sidecarStarting: Promise<ChildProcess> | null = null;

/**
 * CDP port of the browser the API session owns (set by CDPService after each
 * successful launch — nodriver always picks its own free port, so consumers
 * like the DevTools proxy must follow this instead of assuming a fixed one).
 */
let sessionCdpPort = 0;

export function setSessionCdpPort(port: number): void {
  sessionCdpPort = Number(port) || 0;
}

export function getSessionCdpPort(): number {
  return sessionCdpPort;
}

/** Ensure the Python sidecar is running (idempotent). */
export async function ensureSidecar(): Promise<ChildProcess> {
  if (sidecarProcess && !sidecarProcess.killed && sidecarProcess.exitCode === null) {
    return sidecarProcess;
  }
  if (sidecarStarting) return sidecarStarting;

  sidecarStarting = (async () => {
    const script = sidecarScript();
    if (!fs.existsSync(script)) {
      throw new Error(
        `nodriver sidecar script not found at ${script}. ` +
          `The api build must copy api/python/ into build/python/.`,
      );
    }
    const python = venvPython();
    const child = spawn(python, [script], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        NODRIVER_SIDECAR_PORT: String(sidecarPort()),
        // Children inherit the parent's DISPLAY by default; per-launch
        // requests override the display via the sidecar's env passthrough.
      },
    });
    child.on("exit", (code, signal) => {
      console.log(`[nodriver-sidecar] exited code=${code} signal=${signal}`);
      if (sidecarProcess === child) sidecarProcess = null;
    });
    child.unref();
    sidecarProcess = child;

    // Wait until /health answers (the sidecar needs a moment to import).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`nodriver sidecar exited during startup (code ${child.exitCode})`);
      }
      try {
        await sidecarRequest("GET", "/health", null, 1_500);
        return child;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error("nodriver sidecar did not become healthy within 15s");
  })();

  try {
    return await sidecarStarting;
  } finally {
    sidecarStarting = null;
  }
}

function sidecarRequest<T = any>(
  method: "GET" | "POST",
  pathname: string,
  body: unknown,
  timeoutMs = 90_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port: sidecarPort(),
        method,
        path: pathname,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`sidecar returned non-JSON: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`sidecar ${method} ${pathname} timed out`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Launch a browser via the sidecar; resolves with the CDP websocket URL. */
export async function nodriverLaunch(
  req: NodriverLaunchRequest,
  timeoutMs = 90_000,
): Promise<NodriverLaunchResult> {
  await ensureSidecar();
  return sidecarRequest<NodriverLaunchResult>("POST", "/launch", req, timeoutMs);
}

/** Tell the sidecar to terminate a browser it started. */
export async function nodriverClose(pid: number): Promise<void> {
  try {
    await sidecarRequest("POST", "/close", { pid }, 15_000);
  } catch {
    // best-effort; the caller also kills by profile/port if needed
  }
}

export async function nodriverCfVerify(port: number): Promise<boolean> {
  const res = await sidecarRequest<{ ok: boolean; success?: boolean }>("POST", "/cfverify", { port });
  return !!res.success;
}
