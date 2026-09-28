import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import fastifyReplyFrom from "@fastify/reply-from";
import http from "node:http";

const CHROME_DEBUG_ORIGIN = "http://127.0.0.1:9222";

function isChromeDebugUp(timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${CHROME_DEBUG_ORIGIN}/json/version`, { timeout: timeoutMs }, (res) => {
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
  await fastify.register(fastifyReplyFrom, {
    base: CHROME_DEBUG_ORIGIN,
  });

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
      return await reply.from(target);
    } catch (err: any) {
      const code = err?.code || err?.cause?.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
        return reply.code(503).send({
          success: false,
          error: "Browser not running",
          message: "Chrome remote debugging port is not reachable (9222).",
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
