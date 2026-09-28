import { env, toWsUrl } from "@/env";
import { useEffect, useState, useRef } from "react";
import { useSessionsContext } from "@/hooks/use-sessions-context";

function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    // Only accept primitives — a picked object would stringify to
    // "[object Object]" in the log line, which is what we're avoiding.
    if (ok && cur != null && cur !== "" && (typeof cur !== "object" || cur instanceof Date)) {
      return cur;
    }
  }
  return undefined;
}

/** Compact, readable rendering of an arbitrary value for a log line. */
function describe(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return value.message;
  try {
    const s = JSON.stringify(value);
    if (!s || s === "{}" || s === "[]") return "";
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "";
  }
}

function formatLogLine(type: string, log: Record<string, any>): string {
  const method = pick(log, "method", "request.method");
  const url = pick(log, "url", "request.url", "response.url", "navigation.url", "page.url");
  const status = pick(log, "status", "response.status");
  const message = describe(
    pick(
      log,
      "message",
      "text",
      "errorText",
      "failure.errorText",
      "failureText",
      "error.errorText",
      "error.message",
      "error",
    ),
  );

  if (type === "Console" || type === "Log") {
    const msg = message || JSON.stringify(log);
    return String(msg)
      .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+(INFO|WARN|ERROR|DEBUG)\s+/, "")
      .replace(/\n/g, " ")
      .trim();
  }
  if (type === "Request") {
    return `${method || "GET"} ${url || "(no url)"}`;
  }
  if (type === "Response") {
    return `${status ?? "?"} ${url || "(no url)"}`;
  }
  if (type === "Navigation" || type === "BrowserInteraction") {
    const action = pick(log, "interaction.action", "action");
    const navUrl = url || pick(log, "interaction.navigation.url", "page.url");
    if (action && navUrl) return `${action} → ${navUrl}`;
    if (navUrl) return String(navUrl);
    if (action) return String(action);
  }
  if (type === "Error" || type === "PageError" || type === "RequestFailed") {
    return message || describe(url) || (url ? String(url) : "request failed");
  }
  if (message) return String(message);
  if (url) return String(url);
  // last resort: compact JSON without dumping huge objects
  try {
    const s = JSON.stringify(log);
    return s.length > 180 ? s.slice(0, 180) + "…" : s;
  } catch {
    return "";
  }
}

function typeColor(type: string): string {
  if (type === "Console" || type === "Log") return "var(--cyan-a11)";
  if (type === "Request") return "var(--pink-a11)";
  if (type === "Response") return "var(--green-a11)";
  if (type === "Error" || type === "PageError" || type === "RequestFailed")
    return "var(--red-a11)";
  if (type === "Navigation" || type === "BrowserInteraction") return "var(--amber-11)";
  return "var(--gray-11)";
}

export default function SessionLogs({
  id,
  filter,
}: {
  id: string;
  filter?: "all" | "console" | "network";
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const consoleRef = useRef<HTMLDivElement>(null);
  const { useSession } = useSessionsContext();
  const { data: session } = useSession(id);
  const isLive = session?.status === "live";

  useEffect(() => {
    if (!isLive) return;
    const wsUrl = toWsUrl(env.VITE_WS_URL || env.VITE_API_URL, "/v1/sessions/logs");
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (event) => {
      try {
        const batch = JSON.parse(event.data);
        const items = Array.isArray(batch) ? batch : [batch];
        setLogs((prev) =>
          [...prev, ...items].sort(
            (a, b) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          ),
        );
      } catch {}
    };
    return () => ws.close();
  }, [id, isLive]);

  useEffect(() => {
    if (isLive || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const base = env.VITE_API_URL.replace(/\/$/, "");
        const params = new URLSearchParams({ limit: "500" });
        if (session?.createdAt) {
          params.set("startTime", new Date(session.createdAt).toISOString());
        }
        if (session?.duration && session?.createdAt) {
          const end = new Date(
            new Date(session.createdAt).getTime() + Number(session.duration),
          ).toISOString();
          params.set("endTime", end);
        }
        const res = await fetch(`${base}/v1/logs/query?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        const events = data?.events || data?.logs || data || [];
        if (cancelled) return;
        const mapped = (Array.isArray(events) ? events : []).map((e: any, i: number) => {
          const ev = e.event || e;
          return {
            id: e.id || `${i}-${ev.timestamp || Date.now()}`,
            type: ev.type || "Log",
            timestamp: ev.timestamp || e.timestamp || new Date().toISOString(),
            body: ev,
          };
        });
        setLogs(mapped);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isLive, session?.createdAt, session?.duration]);

  // Stick-to-bottom only while the user is already at the bottom. Once they
  // scroll up to read, new log lines never yank the view back down.
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = consoleRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const filtered = logs.filter((log) => {
    const t = log.type || log.body?.type || "";
    if (!filter || filter === "all") return true;
    if (filter === "console")
      return ["Console", "Log", "Error", "PageError"].includes(t);
    if (filter === "network")
      return ["Request", "Response", "RequestFailed", "Navigation", "BrowserInteraction"].includes(
        t,
      );
    return true;
  });

  return (
    <div
      ref={consoleRef}
      className="w-full h-full overflow-y-auto bg-[var(--gray-2)] p-3 font-mono text-[11px] leading-relaxed"
    >
      {filtered.length === 0 && (
        <p className="text-[var(--gray-9)]">
          {isLive ? "Waiting for logs…" : "No logs for this session."}
        </p>
      )}
      {filtered.slice(-300).map((log) => {
        const body =
          log.body ||
          (typeof log.text === "string"
            ? (() => {
                try {
                  return JSON.parse(log.text);
                } catch {
                  return { message: log.text };
                }
              })()
            : log.text || log);
        const type = log.type || body.type || "Log";
        const line = formatLogLine(type, body);
        if (!line || line === "undefined" || line.includes("undefined")) {
          // skip pure garbage lines
          const fallback = formatLogLine(type, body);
          if (!fallback || fallback === "undefined") return null;
        }
        return (
          <div key={log.id} className="mb-1 break-all">
            <span className="text-[var(--gray-9)] tabular-nums">
              {new Date(log.timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              })}
            </span>{" "}
            <span style={{ color: typeColor(type) }} className="font-semibold">
              [{type}]
            </span>{" "}
            <span className="text-[var(--gray-12)]">{line}</span>
          </div>
        );
      })}
    </div>
  );
}
