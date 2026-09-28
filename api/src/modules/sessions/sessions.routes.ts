import { z } from "zod";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  handleLaunchBrowserSession,
  handleGetBrowserContext,
  handleExitBrowserSession,
  handleGetSessionDetails,
  handleGetSessions,
  handleGetSessionStream,
  handleGetSessionLiveDetails,
} from "./sessions.controller.js";
import { handleScrape, handleScreenshot, handlePDF } from "../actions/actions.controller.js";
import { $ref } from "../../plugins/schemas.js";
import {
  CreateSessionRequest,
  RecordedEvents,
  SessionStreamRequest,
  SessionsScrapeRequest,
  SessionsScreenshotRequest,
  SessionsPDFRequest,
} from "./sessions.schema.js";
import { BrowserEventType, EmitEvent } from "../../types/enums.js";
import {
  appendRecordingEvents,
  getRecording,
  flushRecording,
  getRecordingVideoPath,
} from "../../utils/recording-store.js";

async function routes(server: FastifyInstance) {
  server.get(
    "/health",
    {
      schema: {
        operationId: "health",
        description: "Check if the server and browser are running",
        tags: ["Health"],
        summary: "Check if the server and browser are running",
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!server.cdpService.isRunning()) {
        return reply.status(503).send({ status: "service_unavailable" });
      }
      return reply.send({
        status: "ok",
        browser: server.cdpService.getBrowserEngine(),
      });
    },
  );
  server.post(
    "/sessions",
    {
      schema: {
        operationId: "launch_browser_session",
        description: "Launch a browser session",
        tags: ["Sessions"],
        summary: "Launch a browser session",
        body: $ref("CreateSession"),
        response: {
          200: $ref("SessionDetails"),
        },
      },
    },
    async (request: CreateSessionRequest, reply: FastifyReply) =>
      handleLaunchBrowserSession(server, request, reply),
  );

  server.get(
    "/sessions",
    {
      schema: {
        operationId: "get_sessions",
        description: "Get all sessions",
        tags: ["Sessions"],
        summary: "Get all sessions",
        response: {
          200: $ref("MultipleSessions"),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) =>
      handleGetSessions(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId",
    {
      schema: {
        operationId: "get_session_details",
        description: "Get session details",
        tags: ["Sessions"],
        summary: "Get session details",
        response: {
          200: $ref("SessionDetails"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetSessionDetails(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/context",
    {
      schema: {
        operationId: "get_browser_context",
        description: "Get a browser context",
        tags: ["Sessions"],
        summary: "Get a browser context",
        response: {
          200: $ref("SessionContextSchema"),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) =>
      handleGetBrowserContext(server.cdpService, request, reply),
  );

  server.post(
    "/sessions/:sessionId/release",
    {
      schema: {
        operationId: "release_browser_session",
        description: "Release a browser session",
        tags: ["Sessions"],
        summary: "Release a browser session",
        response: {
          200: $ref("ReleaseSession"),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) =>
      handleExitBrowserSession(server, request, reply),
  );

  server.post(
    "/sessions/release",
    {
      schema: {
        operationId: "release_browser_sessions",
        description: "Release browser sessions",
        tags: ["Sessions"],
        summary: "Release browser sessions",
        response: {
          200: $ref("ReleaseSession"),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) =>
      handleExitBrowserSession(server, request, reply),
  );

  server.get(
    "/sessions/debug",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_debugger_stream",
        description: "Returns an HTML page with a live debugger view of the session",
        tags: ["Sessions"],
        summary: "Get session debugger view",
        querystring: $ref("SessionStreamQuery"),
        response: {
          200: $ref("SessionStreamResponse"),
        },
      },
    },
    async (request: SessionStreamRequest, reply: FastifyReply) =>
      handleGetSessionStream(server, request, reply),
  );

  server.post(
    "/events",
    {
      schema: {
        operationId: "receive_events",
        description: "Receive recorded events from the browser",
        tags: ["Sessions"],
        summary: "Receive recorded events from the browser",
        body: $ref("RecordedEvents"),
      },
    },
    async (request: FastifyRequest<{ Body: RecordedEvents }>, reply: FastifyReply) => {
      const sessionId = server.sessionService.activeSession?.id;
      const body = request.body as any;
      const events = body?.events || (Array.isArray(body) ? body : []);
      if (sessionId && events.length) {
        appendRecordingEvents(sessionId, events);
      }
      server.cdpService.getInstrumentationLogger().record({
        type: BrowserEventType.Recording,
        timestamp: new Date().toISOString(),
        data: request.body,
      });
      return reply.send({ status: "ok" });
    },
  );

  server.get(
    "/sessions/:id/live-details",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_live_details",
        description:
          "Returns the live state of the session, including pages, tabs, and browser state",
        tags: ["Sessions"],
        summary: "Get session live details",
        response: {
          200: $ref("SessionLiveDetailsResponse"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
      handleGetSessionLiveDetails(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/recording",
    {
      schema: {
        operationId: "get_session_recording",
        description: "Get DOM recording (rrweb events) for a session",
        tags: ["Sessions"],
        summary: "Get session DOM recording",
        params: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const data = getRecording(request.params.sessionId);
      if (!data) {
        return reply.code(404).send({ message: "No recording found for this session" });
      }
      if (!data.videoUrl && !(data.events && data.events.length)) {
        return reply.code(404).send({ message: "No recording found for this session" });
      }
      return reply.send(data);
    },
  );

  server.get(
    "/sessions/:sessionId/recording/video",
    {
      schema: {
        operationId: "get_session_recording_video",
        description: "Stream session recording video (mp4)",
        tags: ["Sessions"],
        summary: "Get session recording video",
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string" } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const videoPath = getRecordingVideoPath(request.params.sessionId);
      if (!videoPath) {
        return reply.code(404).send({ message: "No video recording for this session" });
      }
      const fs = await import("node:fs");
      const stat = fs.statSync(videoPath);
      reply.header("Content-Type", "video/mp4");
      reply.header("Content-Length", stat.size);
      reply.header("Accept-Ranges", "bytes");
      return reply.send(fs.createReadStream(videoPath));
    },
  );

  server.post(
    "/sessions/scrape",
    {
      schema: {
        operationId: "scrape_session",
        description: "Scrape Current Session",
        tags: ["Sessions"],
        summary: "Scrape Current Session",
        body: $ref("ScrapeRequest"),
        response: {
          200: $ref("ScrapeResponse"),
        },
      },
    },
    async (request: SessionsScrapeRequest, reply: FastifyReply) =>
      handleScrape(server.sessionService, server.cdpService, request, reply),
  );

  server.post(
    "/sessions/screenshot",
    {
      schema: {
        operationId: "screenshot_session",
        description: "Take Screenshot of Current Session",
        tags: ["Sessions"],
        summary: "Take Screenshot of Current Session",
        body: $ref("ScreenshotRequest"),
        response: {
          200: $ref("ScreenshotResponse"),
        },
      },
    },
    async (request: SessionsScreenshotRequest, reply: FastifyReply) =>
      handleScreenshot(server.sessionService, server.cdpService, request, reply),
  );

  server.post(
    "/sessions/pdf",
    {
      schema: {
        operationId: "pdf_session",
        description: "Generate PDF of Current Session",
        tags: ["Sessions"],
        summary: "Generate PDF of Current Session",
        body: $ref("PDFRequest"),
        response: {
          200: $ref("PDFResponse"),
        },
      },
    },
    async (request: SessionsPDFRequest, reply: FastifyReply) =>
      handlePDF(server.sessionService, server.cdpService, request, reply),
  );
}

export default routes;
