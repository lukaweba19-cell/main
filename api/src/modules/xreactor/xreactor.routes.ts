import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleXReactorCheck } from "./xreactor.controller.js";
import { $ref } from "../../plugins/schemas.js";
import { XReactorRequest } from "./xreactor.schema.js";
import {
  edgeTokenOk,
  hostIsXReactor,
  XREACTOR_EDGE_HEADER,
} from "./xreactor.acl.js";

/** ACL hook: host isolation + optional shared-secret edge token. */
async function xreactorAcl(request: FastifyRequest, reply: FastifyReply) {
  if (!hostIsXReactor(request.headers.host)) {
    return reply.code(403).send({
      message: "Forbidden: /xreactor is only served via the designated domain",
    });
  }
  if (!edgeTokenOk(request.headers[XREACTOR_EDGE_HEADER])) {
    return reply.code(403).send({ message: "Forbidden: bad edge token" });
  }
}

const USAGE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XReactor — cloud-mention check</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0a0a0b; color: #e4e4e7; font: 16px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 640px; padding: 2.5rem 1.5rem; }
  h1 { font-size: 1.4rem; letter-spacing: 0.02em; margin: 0 0 0.5rem; }
  h1 span { color: #34d399; }
  p { color: #a1a1aa; margin: 0.4rem 0; }
  code { background: #18181b; border: 1px solid #27272a; border-radius: 6px;
    padding: 0.15rem 0.45rem; color: #93c5fd; word-break: break-all; }
  .verdict { display: inline-block; margin-top: 1rem; padding: 0.2rem 0.6rem;
    border-radius: 999px; font-size: 0.8rem; }
  .allowed { background: rgba(52,211,153,.12); color: #34d399; border: 1px solid rgba(52,211,153,.35); }
  .disallowed { background: rgba(248,113,113,.12); color: #f87171; border: 1px solid rgba(248,113,113,.35); }
</style>
</head>
<body>
<main>
  <h1>xreactor <span>/xreactor</span></h1>
  <p>Checks a URL (plus up to 3 pages it links) for any mention of &quot;cloud&quot; in any spelling.</p>
  <p>Usage: <code>?url=&lt;page-url&gt;</code></p>
  <p><a href="/xreactor?url=https://example.com" style="color:#93c5fd">Try it with example.com</a></p>
  <p style="margin-top:1.2rem">Response:</p>
  <p><span class="allowed">allowed</span> no cloud mention found</p>
  <p><span class="disallowed">disallowed</span> cloud mention detected</p>
</main>
</body>
</html>`;

async function routes(server: FastifyInstance) {
  // Plugin-scoped hook: applies to every route registered below (GET + POST
  // /xreactor) without touching fastify's route-generic inference.
  server.addHook("onRequest", xreactorAcl);

  server.post(
    "/xreactor",
    {
      schema: {
        operationId: "xreactor_check",
        description:
          "Scrape a URL (plus up to 3 linked pages), detect any mention of 'cloud' in any spelling, and return allowed or disallowed",
        tags: ["XReactor"],
        summary: "Cloud-mention compliance check for a URL",
        body: $ref("XReactorCheckRequest"),
        response: {
          200: $ref("XReactorResponse"),
        },
      },
    },
    async (request: XReactorRequest, reply: FastifyReply) =>
      handleXReactorCheck(server.sessionService, server.cdpService, request, reply),
  );

  server.get(
    "/xreactor",
    {
      schema: {
        operationId: "xreactor_check_get",
        description: "GET variant of the xreactor check: pass ?url=...",
        tags: ["XReactor"],
        summary: "Cloud-mention compliance check (GET variant)",
      },
    },
    async (request, reply) => {
      const url = (request.query as any)?.url as string | undefined;
      if (!url || !url.trim()) {
        // Browser-friendly landing: opening the domain root redirects here,
        // so show how to use the endpoint instead of a JSON validation error.
        reply.type("text/html; charset=utf-8");
        return reply.send(USAGE_PAGE_HTML);
      }
      (request as any).body = { url };
      return handleXReactorCheck(
        server.sessionService,
        server.cdpService,
        request as unknown as XReactorRequest,
        reply,
      );
    },
  );
}

export default routes;
