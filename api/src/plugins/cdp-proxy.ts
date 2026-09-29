import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import fastifyReplyFrom from "@fastify/reply-from";
import http from "node:http";
import { getSessionCdpPort } from "../utils/nodriver-client.js";

function chromeDebugOrigin(): string {
  // nodriver picks a fresh free CDP port per launch; fall back to the legacy
  // fixed port when no session browser has been launched yet.
  return `http://127.0.0.1:${getSessionCdpPort() || 9222}`;
}

function isChromeDebugUp(timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${chromeDebugOrigin()}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Proxy Chrome DevTools Protocol HTTP endpoints (DevTools frontend + /json)
 * from this server to the local Chrome remote-debugging port (9222).
 */
const cdpProxyPlugin: FastifyPluginAsync = async (fastify) => {
  // reply-from is registered with no fixed base: the upstream origin is
  // resolved per request (nodriver picks a fresh CDP port per launch).
  await fastify.register(fastifyReplyFrom, { base: "" });

  const ensureBrowser = async (): Promise<boolean> => {
    // Never auto-launch Chrome for DevTools probes — scrapes own the lifecycle.
    return isChromeDebugUp();
  };

  const proxyOr503 = async (request: FastifyRequest, reply: FastifyReply, target: string) => {
    const up = await ensureBrowser();
    if (!up) {
      return reply.code(503).send({
        success: false,
        error: "Browser not running",
        message:
          "Chrome DevTools is unavailable because no browser session is active. Start a session or run a scrape first.",
      });
    }
    try {
      // Full-URL form: reply.from(upstreamUrl) overrides the registered base.
      return await reply.from(`${chromeDebugOrigin()}${target}`);
    } catch (err: any) {
      const code = err?.code || err?.cause?.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
        return reply.code(503).send({
          success: false,
          error: "Browser not running",
          message: "Chrome remote debugging port is not reachable.",
        });
      }
      request.log.error({ err }, "CDP proxy error");
      return reply.code(502).send({
        success: false,
        error: "Bad Gateway",
        message: err?.message || "Failed to proxy to Chrome DevTools",
      });
    }
  };

  fastify.all("/devtools/*", { schema: { hide: true } }, async (request, reply) => {
    return proxyOr503(request, reply, request.url);
  });

  fastify.all("/json", { schema: { hide: true } }, async (request, reply) => {
    return proxyOr503(request, reply, "/json");
  });

  fastify.all("/json/*", { schema: { hide: true } }, async (request, reply) => {
    return proxyOr503(request, reply, request.url);
  });
};

export default fp(cdpProxyPlugin, {
  name: "cdp-proxy",
  fastify: "5.x",
});
