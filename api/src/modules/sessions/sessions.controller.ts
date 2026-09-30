import { CDPService } from "../../services/cdp/cdp.service.js";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getErrors } from "../../utils/errors.js";
import { CreateSessionRequest, SessionDetails, SessionStreamRequest } from "./sessions.schema.js";
import { CookieData } from "../../services/context/types.js";
import { getUrl, getBaseUrl } from "../../utils/url.js";

export const handleLaunchBrowserSession = async (
  server: FastifyInstance,
  request: CreateSessionRequest,
  reply: FastifyReply,
) => {
  try {
    const {
      sessionId,
      proxyUrl,
      userDataDir,
      profileId,
      persist,
      sessionContext,
      sessionExtensions,
      logSinkUrl,
      timezone,
      dimensions,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      userPreferences,
      deviceConfig,
      fullscreen,
      dangerouslyLogRequestDetails,
      captureWorkerNetwork,
      caCertificates,
    } = request.body;

    return await server.sessionService.startSession({
      sessionId,
      proxyUrl,
      userDataDir,
      profileId,
      persist,
      sessionContext: sessionContext as {
        cookies?: CookieData[] | undefined;
        localStorage?: Record<string, Record<string, any>> | undefined;
      },
      sessionExtensions,
      logSinkUrl,
      timezone,
      dimensions,
      blockAds,
      optimizeBandwidth,
      extra: extra as Record<string, unknown> | undefined,
      credentials,
      userPreferences,
      deviceConfig,
      fullscreen,
      dangerouslyLogRequestDetails,
      captureWorkerNetwork,
      caCertificates,
    });
  } catch (e: unknown) {
    server.log.error({ err: e }, "Failed launching browser session");
    const error = getErrors(e);
    return reply.code(500).send({ success: false, message: error });
  }
};

export const handleExitBrowserSession = async (
  server: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const sessionDetails = await server.sessionService.endSession();

    reply.send({ success: true, ...sessionDetails });
  } catch (e: any) {
    const error = getErrors(e);
    return reply.code(500).send({ success: false, message: error });
  }
};

export const handleGetBrowserContext = async (
  browserService: CDPService,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const context = await browserService.getBrowserState();
  return reply.send(context);
};

export const handleGetSessionDetails = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const sessionId = request.params.sessionId;
  const active = server.sessionService.activeSession;

  if (sessionId === active.id) {
    const duration =
      active.status === "live"
        ? new Date().getTime() - new Date(active.createdAt).getTime()
        : active.duration;
    return reply.send({
      ...active,
      duration,
    });
  }

  // A running isolated scrape job reports itself as a live session.
  const job = server.sessionService.getRunningScrapeJob(sessionId);
  if (job) {
    const details = server.sessionService.toLiveSessionDetails(job);
    return reply.send({ ...details, kind: "scrape" as const });
  }

  const past = server.sessionService.pastSessions.find((s) => s.id === sessionId);
  if (past) {
    return reply.send(past);
  }

  return reply.code(404).send({
    message: `Session ${sessionId} not found`,
  });
};

export const handleGetSessions = async (
  server: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  // Only include the active session when it is actually live (browser in use).
  // Idle placeholders after release must NOT appear in the list.
  const sessions: any[] = [];
  const active = server.sessionService.activeSession;
  if (active && active.status === "live") {
    sessions.push({
      ...active,
      duration: new Date().getTime() - new Date(active.createdAt).getTime(),
    });
  }
  // Running isolated scrape jobs are live sessions too — they appear in the
  // list while they run and flip to their released row once finished.
  sessions.push(
    ...server.sessionService.getRunningScrapeJobs().map((job) =>
      server.sessionService.toLiveSessionDetails(job),
    ),
  );
  sessions.push(...server.sessionService.pastSessions);
  return reply.send({ sessions });
};

export const handleGetSessionStream = async (
  server: FastifyInstance,
  request: SessionStreamRequest,
  reply: FastifyReply,
) => {
  const { showControls, theme, interactive, pageId, pageIndex, sessionId } = request.query;

  const singlePageMode = !!(pageId || pageIndex);

  // A running isolated scrape job is watched through its OWN private browser
  // (cast resolves it by session id). Its dims differ from the shared
  // session's, so size the player for the job when one is requested.
  const job = sessionId ? server.sessionService.getRunningScrapeJob(sessionId) : undefined;

  // Construct WebSocket URL with page parameters if present
  let wsUrl = getUrl("v1/sessions/cast", "ws");
  const wsParams: string[] = [];
  if (job) {
    // Tell the cast handler which browser to attach to.
    wsParams.push(`sessionId=${encodeURIComponent(sessionId!)}`);
  }
  if (pageId) {
    wsParams.push(`pageId=${encodeURIComponent(pageId)}`);
  } else if (pageIndex) {
    wsParams.push(`pageIndex=${encodeURIComponent(pageIndex)}`);
  }
  if (wsParams.length) {
    wsUrl += `?${wsParams.join("&")}`;
  }

  return reply.view("live-session-streamer.ejs", {
    wsUrl,
    showControls,
    theme,
    interactive,
    dimensions: job?.dimensions || server.sessionService.activeSession.dimensions,
    singlePageMode,
  });
};

export const handleGetSessionLiveDetails = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const pages = await server.cdpService.getAllPages();

    const pagesInfo = await Promise.all(
      pages.map(async (page) => {
        try {
          const pageId = await server.cdpService.getTargetId(page);

          const title = await page.title().catch(() => "");

          let favicon: string | null = null;
          try {
            favicon = await page.evaluate(() => {
              const iconLink = document.querySelector(
                'link[rel="icon"], link[rel="shortcut icon"]',
              );
              if (iconLink) {
                const href = iconLink.getAttribute("href");
                if (href?.startsWith("http")) return href;
                if (href?.startsWith("//")) return window.location.protocol + href;
                if (href?.startsWith("/")) return window.location.origin + href;
                return window.location.origin + "/" + href;
              }
              return null;
            });
          } catch (error) {}

          return {
            id: pageId,
            url: page.url(),
            title,
            favicon,
          };
        } catch (error) {
          console.error("Error collecting page info:", error);
          return null;
        }
      }),
    );

    const validPagesInfo = pagesInfo.filter((page) => page !== null);

    const browserVersion = await server.cdpService.getBrowserState();

    const browserState = {
      status: server.sessionService.activeSession.status,
      userAgent: server.sessionService.activeSession.userAgent,
      browserVersion,
      initialDimensions: server.sessionService.activeSession.dimensions || {
        width: 1920,
        height: 1080,
      },
      pageCount: validPagesInfo.length,
    };

    return reply.send({
      pages: validPagesInfo,
      browserState,
      websocketUrl: server.sessionService.activeSession.websocketUrl,
      sessionViewerUrl: server.sessionService.activeSession.sessionViewerUrl,
      sessionViewerFullscreenUrl: `${server.sessionService.activeSession.sessionViewerUrl}?showControls=false`,
    });
  } catch (error) {
    console.error("Error getting session state:", error);
    return reply.code(500).send({
      message: "Failed to get session state",
      error: getErrors(error),
    });
  }
};
