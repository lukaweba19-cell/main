import { useSessionsContext } from "@/hooks/use-sessions-context";
import { useRef, useEffect, useCallback, useState } from "react";
import "./session-viewer-controls.css";
import { LoadingSpinner } from "@/components/icons/LoadingSpinner";
import { env } from "@/env";

type SessionViewerProps = {
  id: string;
};

let clipboardBridgeActive = false;

export function SessionViewer({ id }: SessionViewerProps) {
  const { useSession } = useSessionsContext();
  const {
    data: session,
    isLoading: isSessionLoading,
    isError: isSessionError,
  } = useSession(id);

  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [recState, setRecState] = useState<
    "idle" | "loading" | "video" | "empty" | "error"
  >("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

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

  if (isSessionLoading)
    return (
      <div className="flex items-center justify-center w-full h-full">
        <LoadingSpinner className="w-8 h-8" />
      </div>
    );

  if (isSessionError || !session)
    return (
      <div className="flex items-center justify-center w-full h-full border border-[var(--gray-6)]">
        <h1 className="text-[var(--tomato-5)]">Error loading session</h1>
      </div>
    );

  if (isLive) {
    return (
      <div
        ref={containerRef}
        className="flex flex-col w-full overflow-hidden flex-1 border-t border-[var(--gray-6)]"
        tabIndex={0}
        style={{ outline: "none" }}
      >
        <iframe
          ref={iframeRef}
          src={`${session?.debugUrl}${
            session?.debugUrl?.includes("?") ? "&" : "?"
          }clipboardBridge=true`}
          sandbox="allow-same-origin allow-scripts allow-clipboard-write allow-clipboard-read"
          className="w-full max-h-full aspect-[16/10] border border-[var(--gray-6)]"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full overflow-hidden flex-1 border-t border-[var(--gray-6)] bg-[var(--gray-2)]">
      <div className="px-3 py-2 text-xs text-[var(--gray-11)] border-b border-[var(--gray-6)] flex items-center justify-between">
        <span>
          Session <span className="font-mono text-primary">{id.slice(0, 8)}</span> · status{" "}
          <span className="text-primary">{session.status}</span>
        </span>
        <span>Recording playback</span>
      </div>
      {recState === "loading" && (
        <div className="flex items-center justify-center flex-1 gap-2 text-[var(--gray-11)]">
          <LoadingSpinner className="w-6 h-6" /> Loading recording…
        </div>
      )}
      {recState === "empty" && (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-[var(--gray-11)] p-6 text-center">
          <p>No video recording for this session.</p>
          <p className="text-xs max-w-md">
            New scrapes capture a screencast automatically. Re-run a scrape to generate a video.
          </p>
        </div>
      )}
      {recState === "error" && (
        <div className="flex items-center justify-center flex-1 text-[var(--red-11)] p-6">
          {recError || "Failed to load recording"}
        </div>
      )}
      {recState === "video" && videoUrl && (
        <div className="flex-1 flex items-center justify-center p-2 bg-black">
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            autoPlay
            className="max-w-full max-h-full w-full aspect-video"
            style={{ background: "#000" }}
          />
        </div>
      )}
    </div>
  );
}
