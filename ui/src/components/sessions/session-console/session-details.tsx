import { useSessionsContext } from "@/hooks/use-sessions-context";
import { Skeleton } from "@radix-ui/themes";
import { ReleaseSessionDialog } from "../release-session-dialog";
import { Button } from "@/components/ui/button";

function Row({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div className="flex w-full flex-row gap-3 justify-between py-2.5 border-b border-[var(--gray-6)]">
      <div className="text-[var(--gray-10)] shrink-0">{label}</div>
      <div className={`text-right text-[var(--gray-12)] break-all ${mono ? "font-mono text-[11px]" : ""}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

function Feature({
  label,
  on,
}: {
  label: string;
  on: boolean | null;
}) {
  return (
    <div className="flex w-full items-center justify-between py-2 border-b border-[var(--gray-6)]">
      <span className="text-[var(--gray-11)]">{label}</span>
      {on === null ? (
        <span className="text-[var(--gray-9)] text-xs">—</span>
      ) : on ? (
        <span className="text-[var(--green-11)] text-xs font-medium">✓ On</span>
      ) : (
        <span className="text-[var(--gray-9)] text-xs">– Off</span>
      )}
    </div>
  );
}

function formatDuration(ms?: number) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function SessionDetails({ id }: { id: string | null }) {
  const { useSession } = useSessionsContext();
  const { data: session, isLoading, isError } = useSession(id!);

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="w-full h-4" />
        ))}
      </div>
    );
  }

  if (isError || !session) {
    return <div className="p-4 text-[var(--red-11)]">Error loading session</div>;
  }

  const dims = session.dimensions;
  const viewport =
    dims?.width && dims?.height ? `${dims.width} × ${dims.height}` : "—";

  return (
    <div className="w-full h-full overflow-y-auto bg-[var(--gray-2)] p-4 text-xs flex flex-col">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-md border border-[var(--gray-6)] p-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--gray-9)]">Duration</div>
          <div className="text-sm font-medium text-[var(--gray-12)] mt-1 tabular-nums">
            {formatDuration(Number(session.duration) || 0)}
          </div>
        </div>
        <div className="rounded-md border border-[var(--gray-6)] p-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--gray-9)]">Started</div>
          <div className="text-sm font-medium text-[var(--gray-12)] mt-1">
            {session.createdAt
              ? new Date(session.createdAt).toLocaleString()
              : "—"}
          </div>
        </div>
        <div className="rounded-md border border-[var(--gray-6)] p-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--gray-9)]">Viewport</div>
          <div className="text-sm font-medium text-[var(--gray-12)] mt-1">{viewport}</div>
        </div>
        <div className="rounded-md border border-[var(--gray-6)] p-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--gray-9)]">Status</div>
          <div className="text-sm font-medium text-[var(--gray-12)] mt-1 capitalize">
            {session.status}
          </div>
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wide text-[var(--gray-9)] mb-1">Session</div>
      <Row label="ID" value={session.id} mono />
      <Row
        label="User Agent"
        value={session.userAgent || "—"}
        mono
      />
      <Row label="Proxy" value={session.proxy || "—"} mono />
      <Row label="Websocket" value={session.websocketUrl || "—"} mono />

      <div className="text-[10px] uppercase tracking-wide text-[var(--gray-9)] mt-5 mb-1">
        Features
      </div>
      <Feature label="Captcha solver (NopeCHA)" on={true} />
      <Feature label="Proxy" on={!!session.proxy} />
      <Feature label="Video recording" on={session.status !== "live"} />

      {session.status === "live" && (
        <div className="mt-auto border-t border-[var(--gray-6)] pt-4">
          <ReleaseSessionDialog id={id!}>
            <Button
              variant="outline"
              className="flex w-full bg-transparent text-[var(--red-11)] border-[var(--red-7)] hover:bg-[var(--red-3)]"
            >
              Release Session
            </Button>
          </ReleaseSessionDialog>
        </div>
      )}
    </div>
  );
}
