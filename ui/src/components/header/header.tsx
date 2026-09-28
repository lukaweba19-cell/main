import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Badge } from "@/components/ui/badge";
import { GlowingGreenDot } from "@/components/icons/GlowingGreenDot";
import { useSessionsContext } from "@/hooks/use-sessions-context";
import { SteelIcon } from "../icons/SessionIcon";
import { Link, useLocation, useParams } from "react-router-dom";

export const Header = () => {
  const { pathname } = useLocation();
  const { id: routeId } = useParams();
  const currentSessionId =
    pathname.includes("/sessions/") && routeId && routeId !== "sessions"
      ? routeId
      : null;

  const { useSession, useSessions } = useSessionsContext();
  const { data: session, isLoading } = useSession(currentSessionId || "");
  const { data: sessionsData } = useSessions();
  const liveCount =
    sessionsData?.sessions?.filter((s) => s.status === "live").length ?? 0;
  const totalCount = sessionsData?.sessions?.length ?? 0;

  return (
    <header className="flex justify-between items-center pl-3 pr-6 h-16 w-full border-b border-[var(--gray-6)]">
      <div className="flex items-center gap-4 flex-1">
        <Link
          to="/sessions"
          className="flex items-center gap-2 text-primary hover:opacity-90"
        >
          <SteelIcon />
          <span className="font-medium">Steel</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/sessions"
            className={`px-3 py-1.5 rounded-md ${
              pathname === "/sessions" || pathname.endsWith("/sessions")
                ? "bg-[var(--gray-3)] text-primary"
                : "text-[var(--gray-11)] hover:text-primary"
            }`}
          >
            Sessions
          </Link>
        </nav>
      </div>

      <div className="flex items-center gap-2 text-muted-foreground">
        {currentSessionId ? (
          <>
            <Link to="/sessions" className="text-[var(--gray-11)] hover:text-primary text-sm">
              Sessions
            </Link>
            <ChevronRightIcon />
            <div className="flex items-center gap-1.5 text-primary">
              <span className="text-sm font-mono">
                #{currentSessionId.split("-")[0]}
              </span>
              {!isLoading && session?.status === "live" && (
                <Badge
                  variant="secondary"
                  className="text-[var(--green-a12)] border border-[var(--green-6)] bg-transparent gap-2 py-0.5 px-2.5 mb-0.5 flex items-center justify-between max-w-fit rounded-full"
                >
                  <GlowingGreenDot />
                  Live
                </Badge>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[var(--gray-11)]">
              Active{" "}
              <span className="font-mono text-[var(--green-11)]">{liveCount}</span>
              <span className="text-[var(--gray-9)]"> / {totalCount}</span>
            </span>
          </div>
        )}
      </div>

      <nav className="flex-1 flex justify-end">
        <div className="flex gap-2 items-center">
          <a
            href="https://docs.steel.dev"
            target="_blank"
            rel="noreferrer"
            className="rounded-md opacity-90 bg-transparent flex h-9 px-3 justify-center items-center gap-2 text-primary hover:bg-[rgba(238,206,254,0.13)] font-inter text-sm font-normal cursor-pointer"
          >
            Docs
          </a>
          <a
            href="https://discord.gg/steel-dev"
            target="_blank"
            rel="noreferrer"
            className="rounded-md opacity-90 bg-transparent flex h-9 px-3 justify-center items-center gap-2 text-primary hover:bg-[rgba(238,206,254,0.13)] font-inter text-sm font-normal cursor-pointer"
          >
            Discord
          </a>
        </div>
      </nav>
    </header>
  );
};
