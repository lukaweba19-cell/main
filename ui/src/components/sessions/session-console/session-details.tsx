import { useSessionsContext } from "@/hooks/use-sessions-context";
import { Skeleton } from "@radix-ui/themes";
import { ReleaseSessionDialog } from "../release-session-dialog";
import { Button } from "@/components/ui/button";
import {
  GlobeIcon,
  MagicWandIcon,
  VideoIcon,
  MinusIcon,
  CheckIcon,
} from "@radix-ui/react-icons";

function Row({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div className="flex w-full flex-row gap-4 justify-between items-baseline py-2.5">
      <div className="text-sm text-[var(--gray-11)] shrink-0">{label}</div>
      <div
        className={`text-right text-sm text-[var(--gray-12)] break-all min-w-0 ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function Feature({
  label,
  on,
  icon,
}: {
  label: string;
  on: boolean | null;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center justify-between py-2.5">
      <span className="flex items-center gap-2.5 text-sm text-[var(--gray-12)]">
        <span className="text-[var(--gray-10)]">{icon}</span>
        {label}
      </span>
      {on === null ? (
        <span className="flex items-center gap-1 text-[var(--gray-9)] text-sm">
          <MinusIcon className="w-3.5 h-3.5" /> Off
        </span>
      ) : on ? (
        <span className="flex items-center gap-1.5 text-[var(--green-11)] text-sm">
          <CheckIcon className="w-3.5 h-3.5" /> On
        </span>
      ) : (
        <span className="flex items-center gap-1 text-[var(--gray-9)] text-sm">
          <MinusIcon className="w-3.5 h-3.5" /> Off
        </span>
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
  if (h > 0)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
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
    return <div className="p-4 text-sm text-[var(--red-11)]">Error loading session</div>;
  }

  const dims = session.dimensions;
  const viewport =
    dims?.width && dims?.height ? `${dims.width} × ${dims.height}` : "—";

  return (
    <div className="w-full px-4 py-3 text-[var(--gray-12)] flex flex-col divide-y divide-[var(--gray-6)]">
      <div className="pb-1">
        <Row label="Viewport" value={viewport} mono />
      </div>

      <div className="py-3">
        <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--gray-9)] mb-1.5">
          Features
        </div>
        <Feature label="Captcha solver (NopeCHA)" on={true} icon={<MagicWandIcon />} />
        <Feature label="Proxy" on={!!session.proxy} icon={<GlobeIcon />} />
        <Feature
          label="Video recording"
          on={session.status !== "live"}
          icon={<VideoIcon />}
        />
      </div>

      <div className="pt-3">
        <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--gray-9)] mb-1.5">
          Recording
        </div>
        <Row
          label="Duration"
          value={formatDuration(Number(session.duration) || 0)}
          mono
        />
        <Row label="File" value={session.id ? `${session.id.slice(0, 8)}.mp4` : "—"} mono />
        <Row label="Status" value={session.status === "live" ? "Recording…" : "Saved"} />
      </div>

      <div className="pt-4">
        <Row label="ID" value={session.id} mono />
        <Row label="User Agent" value={session.userAgent || "—"} mono />
        <Row label="Proxy" value={session.proxy || "—"} mono />
        <Row label="Websocket" value={session.websocketUrl || "—"} mono />
      </div>

      {session.status === "live" && (
        <div className="pt-4">
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
