import { useSessionsContext } from "@/hooks/use-sessions-context";
import { useRef, useEffect, useCallback, useState } from "react";
import "./session-viewer-controls.css";
import { LoadingSpinner } from "@/components/icons/LoadingSpinner";
import { PlayIcon, PauseIcon } from "@radix-ui/react-icons";
import { env } from "@/env";

type SessionViewerProps = {
  id: string;
};

let clipboardBridgeActive = false;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SessionViewer({ id }: SessionViewerProps) {
  const { useSession } = useSessionsContext();
  const {
    data: session,
    isLoading: isSessionLoading,
    isError: isSessionError,
  } = useSession(id);

  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recState, setRecState] = useState<
    "idle" | "loading" | "video" | "empty" | "error"
  >("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  // Playback state for the custom scrubber
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const isLive = session?.status === "live";

  useEffect(() => {
    if (!id || isLive || isSessionLoading) return;
    let cancelled = false;
    setRecState("loading");
    setRecError(null);
    setVideoUrl(null);

    (async () => {
      try {
        const base = env.VITE_API_URL.replace(/\/$/, "");
        const res = await fetch(`${base}/v1/sessions/${id}/recording`);
        if (!res.ok) {
          if (res.status === 404) {
            if (!cancelled) setRecState("empty");
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;
        if (data.videoUrl || data.format === "webm" || data.format === "mp4") {
          const url = data.videoUrl?.startsWith("http")
            ? data.videoUrl
            : `${base}${data.videoUrl || `/v1/sessions/${id}/recording/video`}`;
          setVideoUrl(url);
          setRecState("video");
          return;
        }
        setRecState("empty");
      } catch (err: any) {
        if (!cancelled) {
          setRecState("error");
          setRecError(err?.message || "Failed to load recording");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, isLive, isSessionLoading]);

  const handleMessage = useCallback(async (event: MessageEvent) => {
    if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
      return;
    }
    try {
      switch (event.data.type) {
        case "requestClipboardRead":
          try {
            const text = await navigator.clipboard.readText();
            iframeRef.current.contentWindow?.postMessage(
              { type: "clipboardReadResponse", text, requestId: event.data.requestId },
              "*",
            );
          } catch (err) {
            iframeRef.current.contentWindow?.postMessage(
              {
                type: "clipboardReadResponse",
                text: "",
                error: String(err),
                requestId: event.data.requestId,
              },
              "*",
            );
          }
          break;
        case "requestClipboardWrite":
          try {
            await navigator.clipboard.writeText(event.data.text || "");
            iframeRef.current.contentWindow?.postMessage(
              { type: "clipboardWriteResponse", success: true, requestId: event.data.requestId },
              "*",
            );
          } catch (err) {
            iframeRef.current.contentWindow?.postMessage(
              {
                type: "clipboardWriteResponse",
                success: false,
                error: String(err),
                requestId: event.data.requestId,
              },
              "*",
            );
          }
          break;
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isLive) return;
    if (!clipboardBridgeActive) {
      window.addEventListener("message", handleMessage);
      clipboardBridgeActive = true;
    }
    return () => {
      window.removeEventListener("message", handleMessage);
      clipboardBridgeActive = false;
    };
  }, [handleMessage, isLive]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
  };

  if (isSessionLoading)
    return (
      <div className="flex items-center justify-center w-full aspect-video">
        <LoadingSpinner className="w-8 h-8" />
      </div>
    );

  if (isSessionError || !session)
    return (
      <div className="flex items-center justify-center w-full aspect-video">
        <h1 className="text-[var(--tomato-5)]">Error loading session</h1>
      </div>
    );

  if (isLive) {
    return (
      <div
        ref={containerRef}
        className="flex flex-col w-full overflow-hidden"
        tabIndex={0}
        style={{ outline: "none" }}
      >
        <iframe
          ref={iframeRef}
          src={`${session?.debugUrl}${
            session?.debugUrl?.includes("?") ? "&" : "?"
          }clipboardBridge=true`}
          sandbox="allow-same-origin allow-scripts allow-clipboard-write allow-clipboard-read"
          className="w-full aspect-[16/10]"
          allow="clipboard-read; clipboard-write"
        />
        <div className="px-4 py-2.5 border-t border-[var(--gray-6)] bg-[var(--gray-3)] flex items-center justify-between">
          <span className="text-xs text-[var(--gray-11)]">
            Live session — viewing the browser in real time
          </span>
          <span className="flex items-center gap-1.5 text-xs text-[var(--green-11)]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--green-11)] animate-pulse" />
            Live
          </span>
        </div>
      </div>
    );
  }

  const progress =
    videoDuration > 0 ? Math.min(100, (currentTime / videoDuration) * 100) : 0;

  return (
    <div className="flex flex-col w-full">
      {recState === "loading" && (
        <div className="flex items-center justify-center w-full aspect-video gap-2 text-[var(--gray-11)]">
          <LoadingSpinner className="w-6 h-6" /> Loading recording…
        </div>
      )}
      {recState === "empty" && (
        <div className="flex flex-col items-center justify-center w-full aspect-video gap-2 text-[var(--gray-11)] p-6 text-center">
          <p>No video recording for this session.</p>
          <p className="text-xs max-w-md text-[var(--gray-10)]">
            Every scrape records automatically. Re-run a scrape to generate a video.
          </p>
        </div>
      )}
      {recState === "error" && (
        <div className="flex items-center justify-center w-full aspect-video text-[var(--red-11)] p-6">
          {recError || "Failed to load recording"}
        </div>
      )}
      {recState === "video" && videoUrl && (
        <>
          <div className="bg-black">
            <video
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              className="w-full aspect-video"
              style={{ background: "#000" }}
              onClick={togglePlay}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
            />
          </div>
          {/* Scrubber bar */}
          <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--gray-6)] bg-[var(--gray-3)]">
            <button
              onClick={togglePlay}
              className="flex items-center justify-center w-8 h-8 rounded-full text-[var(--gray-12)] hover:bg-[var(--gray-5)] transition-colors"
              title={playing ? "Pause" : "Play"}
            >
              {playing ? (
                <PauseIcon className="w-4 h-4" />
              ) : (
                <PlayIcon className="w-4 h-4" />
              )}
            </button>
            <span className="text-xs font-mono tabular-nums text-[var(--gray-11)] whitespace-nowrap">
              {formatTime(currentTime)} / {formatTime(videoDuration)}
            </span>
            <div
              className="relative flex-1 h-1.5 rounded-full bg-[var(--gray-5)] cursor-pointer group"
              onClick={handleSeek}
            >
              <div
                className="absolute left-0 top-0 h-full rounded-full bg-[var(--gray-12)]"
                style={{ width: `${progress}%` }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-[var(--gray-12)] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ left: `${progress}%` }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
