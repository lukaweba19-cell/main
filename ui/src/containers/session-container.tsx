import SessionConsole from "@/components/sessions/session-console";
import { SessionViewer } from "@/components/sessions/session-viewer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSessionsContext } from "@/hooks/use-sessions-context";
import { ChevronRightIcon, CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

function formatDuration(ms?: number) {
  if (!ms || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--gray-9)]">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-mono font-medium tabular-nums text-[var(--gray-12)] truncate">
        {children}
      </div>
    </div>
  );
}

export function SessionContainer() {
  const { id } = useParams();
  const { useSession } = useSessionsContext();
  const { data: session, isLoading, isError } = useSession(id!);
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--gray-11)]">
        Loading session…
      </div>
    );
  }

  if (isError || !session) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--gray-11)]">
        <p>Session not found or failed to load.</p>
        <Button variant="outline" className="bg-transparent" asChild>
          <Link to="/sessions">Back to sessions</Link>
        </Button>
      </div>
    );
  }

  const isLive = session.status === "live";
  const dims = session.dimensions;
  const viewport =
    dims?.width && dims?.height ? `${dims.width} × ${dims.height}` : "—";

  return (
    <div className="flex flex-col h-full w-full overflow-y-auto bg-[var(--gray-1)]">
      {/* Breadcrumb header */}
      <div className="shrink-0 border-b border-[var(--gray-6)] px-6 py-4 flex flex-wrap items-center gap-x-3 gap-y-2 justify-between bg-[var(--gray-2)]">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Link
            to="/sessions"
            className="text-sm text-[var(--gray-11)] hover:text-[var(--gray-12)] transition-colors"
          >
            Sessions
          </Link>
          <ChevronRightIcon className="w-3.5 h-3.5 text-[var(--gray-9)] shrink-0" />
          <span className="font-mono text-base font-medium text-[var(--gray-12)]">
            {session.id.slice(0, 8)}
          </span>
          <button
            onClick={copyId}
            title="Copy session ID"
            className="text-[var(--gray-10)] hover:text-[var(--gray-12)] transition-colors"
          >
            {copied ? (
              <CheckIcon className="w-3.5 h-3.5 text-[var(--green-11)]" />
            ) : (
              <CopyIcon className="w-3.5 h-3.5" />
            )}
          </button>
          <Badge
            variant="outline"
            className={`rounded-full font-normal ${
              isLive
                ? "border-[var(--green-7)] text-[var(--green-11)]"
                : "border-[var(--gray-7)] text-[var(--gray-11)]"
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                isLive ? "bg-[var(--green-11)]" : "bg-[var(--gray-9)]"
              }`}
            />
            {isLive ? "Live" : "Released"}
          </Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="bg-transparent font-mono text-xs"
          asChild
        >
          <Link to="/sessions">All sessions</Link>
        </Button>
      </div>

      {/* Stacked content */}
      <div className="flex flex-col gap-4 p-6 max-w-6xl w-full mx-auto">
        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Duration">{formatDuration(Number(session.duration) || 0)}</Stat>
          <Stat label="Started">
            {session.createdAt
              ? new Date(session.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })
              : "—"}
          </Stat>
          <Stat label="Viewport">{viewport}</Stat>
          <Stat label="User Agent">
            {session.userAgent ? session.userAgent.slice(0, 28) + "…" : "—"}
          </Stat>
        </div>

        {/* Video card */}
        <div className="rounded-lg border border-[var(--gray-6)] bg-[var(--gray-2)] overflow-hidden">
          <SessionViewer id={session.id} />
        </div>

        {/* Tabs card */}
        <div className="rounded-lg border border-[var(--gray-6)] bg-[var(--gray-2)] overflow-hidden">
          <SessionConsole id={session.id} />
        </div>
      </div>
    </div>
  );
}
