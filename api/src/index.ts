import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySensible from "@fastify/sensible";
import steelBrowserPlugin from "./steel-browser-plugin.js";
import uiPlugin from "./plugins/ui-plugin.js";
import cdpProxyPlugin from "./plugins/cdp-proxy.js";
import { loggingConfig } from "./config.js";
import { MB } from "./utils/size.js";
import path from "node:path";
import fs from "node:fs";
import {
  hostIsXReactor,
  isXReactorPath,
} from "./modules/xreactor/xreactor.acl.js";
import {
  startMaintenanceLoop,
  runMaintenancePass,
  clearAllSessionHistory,
  flushOldRecordings,
} from "./utils/janitor.js";
import { sweepStaleProfiles } from "./modules/xreactor/xreactor.browser.js";
import { reapOrphanRecorders } from "./utils/scrape/page-recording.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export const server = fastify({
  logger: loggingConfig[process.env.NODE_ENV ?? "development"] ?? true,
  trustProxy: true,
  bodyLimit: 100 * MB,
  disableRequestLogging: true,
});

function resolveUiDistPath(): string | null {
  const candidates = [
    process.env.UI_DIST_PATH,
    path.join(process.cwd(), "ui/dist"),
    path.join(process.cwd(), "../ui/dist"),
    path.join(process.cwd(), "../../ui/dist"),
    "/root/steel-browser/ui/dist",
    "/app/ui/dist",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

const setupServer = async () => {
  await server.register(fastifySensible);
  await server.register(fastifyCors, { origin: true });

  // XReactor domain isolation: the xreactor domain serves exactly ONE thing.
  // Any other path requested under that Host (/, /ui, /v1/*, ...) bounces to
  // /xreactor, so the domain always lands on the endpoint no matter what the
  // visitor types. The endpoint itself additionally requires this Host, and
  // the IP:PORT address can never reach it.
  server.addHook("onRequest", async (request, reply) => {
    if (hostIsXReactor(request.headers.host) && !isXReactorPath(request.raw.url)) {
      return reply.code(302).header("location", "/xreactor").send();
    }
  });

  // Register UI plugin when built UI files are available
  const uiDistPath = resolveUiDistPath();
  if (uiDistPath) {
    await server.register(uiPlugin, {
      uiDistPath,
      uiPrefix: "/ui",
    });
  } else {
    server.log.info("UI dist not found, skipping UI serving");
  }

  await server.register(steelBrowserPlugin, {
    fileStorage: {
      maxSizePerSession: 100 * MB,
    },
    // Persist browser events (Console/Network tabs in the UI). Without this
    // the in-memory store (1000 events, wiped on restart) is used, and
    // session log queries come back empty.
    logging: {
      enableStorage: true,
      enableConsoleLogging: true,
      enableLogsRoutes: true,
    },
  });

  // CDP HTTP proxy AFTER steel plugin so cdpService can auto-launch if needed
  await server.register(cdpProxyPlugin);
};

const startServer = async () => {
  try {
    await setupServer();
    await server.listen({ port: PORT, host: HOST });

    // Daily flush: hourly pass deletes recordings + session history older
    // than 24h (defaults) and sweeps stale xreactor profile dirs, keeping the
    // server's memory and disk footprint flat. A restart also flushes the
    // previous process' stale in-memory session history immediately.
    if (server.sessionService) {
      const pastSessions = server.sessionService.pastSessions as Array<{ createdAt?: string }>;
      const flushed = clearAllSessionHistory(pastSessions);
      const recs = flushOldRecordings();
      // Kill ffmpeg x11grab orphans from previous runs immediately — a leaked
      // encoder burns a full core (this exact leak made the VM feel laggy).
      const reaped = await reapOrphanRecorders();
      if (flushed || recs.filesRemoved || reaped) {
        server.log.info(
          `[janitor] startup flush: ${flushed} stale session(s), ${recs.filesRemoved} old recording(s)` +
            (reaped ? `, killed ${reaped} orphaned recorder(s)` : ""),
        );
      }
      startMaintenanceLoop(pastSessions, (msg) => server.log.info(msg), sweepStaleProfiles);
      void runMaintenancePass; // referenced via the loop; keep import used
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

startServer();
