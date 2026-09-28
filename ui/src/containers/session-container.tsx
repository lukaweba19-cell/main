import SessionConsole from "@/components/sessions/session-console";
import { SessionViewer } from "@/components/sessions/session-viewer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSessionsContext } from "@/hooks/use-sessions-context";
import { ArrowLeftIcon, ArrowRightIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

function formatDuration(ms?: number) {
  if (!ms || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function SessionContainer() {
  const { id } = useParams();
  const { useSession } = useSessionsContext();
  const { data: session, isLoading, isError } = useSession(id!);
  const [showConsole, setShowConsole] = useState(true);

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
    <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--gray-1)]">
      {/* Top bar */}
      <div className="shrink-0 border-b border-[var(--gray-6)] px-4 py-3 flex flex-wrap items-center gap-3 justify-between bg-[var(--gray-2)]">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" className="px-2" asChild>
            <Link to="/sessions">
              <ArrowLeftIcon className="w-4 h-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-[var(--gray-12)] truncate">
                {session.id.slice(0, 8)}
              </span>
              <Badge
                variant="outline"
                className={
                  isLive
                    ? "border-[var(--green-7)] text-[var(--green-11)]"
                    : "text-[var(--gray-11)]"
                }
              >
                {session.status}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div>
            <span className="text-[var(--gray-9)] uppercase tracking-wide text-[10px] block">
              Duration
            </span>
            <span className="tabular-nums text-[var(--gray-12)]">
              {formatDuration(Number(session.duration) || 0)}
            </span>
          </div>
          <div>
            <span className="text-[var(--gray-9)] uppercase tracking-wide text-[10px] block">
              Viewport
            </span>
            <span className="text-[var(--gray-12)]">{viewport}</span>
          </div>
          <div className="hidden sm:block max-w-[200px]">
            <span className="text-[var(--gray-9)] uppercase tracking-wide text-[10px] block">
              User Agent
            </span>
            <span className="text-[var(--gray-12)] truncate block font-mono text-[10px]">
              {session.userAgent ? session.userAgent.slice(0, 42) + "…" : "—"}
            </span>
          </div>
          <Button variant="outline" size="sm" className="bg-transparent" asChild>
            <Link to="/sessions">All sessions</Link>
          </Button>
        </div>
      </div>

      {/* Main: viewer + console */}
      <div className="flex flex-1 min-h-0 overflow-hidden p-3 gap-3">
        <div
          className={`flex flex-col min-h-0 min-w-0 border border-[var(--gray-6)] rounded-lg overflow-hidden bg-[var(--gray-2)] relative ${
            showConsole ? "flex-[1.4]" : "flex-1"
          }`}
        >
          <div className="absolute top-2 right-2 z-10">
            <Button
              variant="outline"
              size="icon"
              className="bg-[var(--gray-2)]/90 border-[var(--gray-6)] h-8 w-8"
              onClick={() => setShowConsole((v) => !v)}
            >
              {showConsole ? (
                <ArrowRightIcon className="w-4 h-4" />
              ) : (
                <ArrowLeftIcon className="w-4 h-4" />
              )}
            </Button>
          </div>
          <SessionViewer id={session.id} />
        </div>

        {showConsole && (
          <div className="flex flex-col min-h-0 w-full max-w-[420px] border border-[var(--gray-6)] rounded-lg overflow-hidden bg-[var(--gray-2)]">
            <SessionConsole id={session.id} />
          </div>
        )}
      </div>
    </div>
  );
}
