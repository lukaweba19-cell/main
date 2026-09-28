import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSessionsContext } from "@/hooks/use-sessions-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GlowingGreenDot } from "@/components/icons/GlowingGreenDot";
import { SessionDetails } from "@/steel-client";

function formatDuration(ms?: number) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTime(iso?: string | Date) {
  if (!iso) return "—";
  try {
    const d = iso instanceof Date ? iso : new Date(iso);
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}

function StatusBadge({ status }: { status?: string }) {
  const s = (status || "unknown").toLowerCase();
  if (s === "live") {
    return (
      <Badge
        variant="secondary"
        className="text-[var(--green-a12)] border border-[var(--green-6)] bg-transparent gap-1.5 py-0.5 px-2 flex items-center max-w-fit rounded-full"
      >
        <GlowingGreenDot />
        Live
      </Badge>
    );
  }
  if (s === "released") {
    return (
      <Badge variant="outline" className="text-[var(--gray-11)] border-[var(--gray-6)]">
        Released
      </Badge>
    );
  }
  if (s === "idle") {
    return (
      <Badge variant="outline" className="text-[var(--amber-11)] border-[var(--amber-6)]">
        Idle
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[var(--gray-11)]">
      {status || "unknown"}
    </Badge>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-[var(--gray-6)] bg-[var(--gray-2)] px-4 py-3 min-w-[140px] flex-1">
      <div className="text-xs text-[var(--gray-11)] uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold font-mono ${accent || "text-primary"}`}>{value}</div>
    </div>
  );
}

export function SessionsDashboard() {
  const navigate = useNavigate();
  const { useSessions, useReleaseSessionMutation } = useSessionsContext();
  const { data, isLoading, isError, refetch, isFetching } = useSessions();
  const releaseMutation = useReleaseSessionMutation();

  const sessions: SessionDetails[] = data?.sessions ?? [];

  const stats = useMemo(() => {
    const live = sessions.filter((s) => s.status === "live").length;
    const released = sessions.filter((s) => s.status === "released").length;
    const idle = sessions.filter((s) => s.status === "idle").length;
    return { total: sessions.length, live, released, idle };
  }, [sessions]);

  const handleRowClick = (id: string) => {
    navigate(`/sessions/${id}`);
  };

  const handleRelease = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    releaseMutation.mutate(id);
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden p-4 gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-primary">Sessions</h1>
          <p className="text-sm text-[var(--gray-11)]">
            Active scrapers and browser sessions. Click a row to open live view and details.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="bg-transparent border-[var(--gray-6)]"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Live / Active" value={stats.live} accent="text-[var(--green-11)]" />
        <StatCard label="Idle" value={stats.idle} accent="text-[var(--amber-11)]" />
        <StatCard label="Released" value={stats.released} accent="text-[var(--gray-11)]" />
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-[var(--gray-6)] bg-[var(--gray-2)]">
        {isLoading && (
          <div className="p-6 text-sm text-[var(--gray-11)]">Loading sessions…</div>
        )}
        {isError && (
          <div className="p-6 text-sm text-[var(--red-11)]">Failed to load sessions.</div>
        )}
        {!isLoading && !isError && sessions.length === 0 && (
          <div className="p-6 text-sm text-[var(--gray-11)]">
            No sessions yet. Start one via the API or wait for a scrape job.
          </div>
        )}
        {!isLoading && !isError && sessions.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="border-[var(--gray-6)] hover:bg-transparent">
                <TableHead className="text-[var(--gray-11)]">Status</TableHead>
                <TableHead className="text-[var(--gray-11)]">Session ID</TableHead>
                <TableHead className="text-[var(--gray-11)]">Created</TableHead>
                <TableHead className="text-[var(--gray-11)]">Duration</TableHead>
                <TableHead className="text-[var(--gray-11)]">Proxy</TableHead>
                <TableHead className="text-[var(--gray-11)]">User Agent</TableHead>
                <TableHead className="text-[var(--gray-11)] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow
                  key={session.id}
                  className="border-[var(--gray-6)] cursor-pointer hover:bg-[var(--gray-3)]"
                  onClick={() => handleRowClick(session.id)}
                >
                  <TableCell>
                    <StatusBadge status={session.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className="text-primary">{session.id.slice(0, 8)}</span>
                    <span className="text-[var(--gray-9)]">…</span>
                  </TableCell>
                  <TableCell className="text-xs text-[var(--gray-11)]">
                    {formatTime(session.createdAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {formatDuration(session.duration)}
                  </TableCell>
                  <TableCell className="text-xs max-w-[160px] truncate text-[var(--gray-11)]">
                    {session.proxy ? session.proxy.replace(/:[^:@]+@/, ":****@") : "—"}
                  </TableCell>
                  <TableCell className="text-xs max-w-[200px] truncate text-[var(--gray-11)]">
                    {session.userAgent ? session.userAgent.slice(0, 48) + "…" : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs bg-transparent border-[var(--gray-6)]"
                        asChild
                      >
                        <Link to={`/sessions/${session.id}`}>Open</Link>
                      </Button>
                      {session.status === "live" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs bg-transparent border-[var(--red-7)] text-[var(--red-11)]"
                          disabled={releaseMutation.isLoading}
                          onClick={(e) => handleRelease(e, session.id)}
                        >
                          Release
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
