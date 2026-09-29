import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleXReactorCheck } from "./xreactor.controller.js";
import { $ref } from "../../plugins/schemas.js";
import { XReactorRequest } from "./xreactor.schema.js";
import {
  edgeTokenOk,
  hostIsXReactor,
  xreactorAllowedHost,
  XREACTOR_EDGE_HEADER,
} from "./xreactor.acl.js";
import scalarTheme from "../../plugins/scalar-theme.js";

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

/**
 * Standalone Scalar API-reference page — the same viewer /documentation uses —
 * with an inline OpenAPI spec stripped down to the xreactor endpoint only.
 * Served when GET /xreactor is opened without a url parameter.
 */
function scalarReferenceHtml(server: FastifyInstance): string {
  const full = server.swagger() as {
    paths: Record<string, unknown>;
    components?: unknown;
    openapi?: string;
  };
  const spec = {
    openapi: full.openapi ?? "3.0.3",
    // Only the xreactor endpoint is exposed through this domain.
    paths: full.paths["/xreactor"] ? { "/xreactor": full.paths["/xreactor"] } : {},
    components: full.components ?? {},
    servers: [{ url: `https://${xreactorAllowedHost()}` }],
    info: {
      title: "XReactor API",
      version: "1.0.0",
      description:
        "Checks a URL (plus up to 3 pages it links) for any mention of 'cloud' in any spelling and returns **allowed** or **disallowed**.",
    },
  };

  // "</script" inside the JSON would terminate the script tag early.
  const specJson = JSON.stringify(spec).replace(/</g, "\\u003c");
  const config = JSON.stringify({
    darkMode: true,
    customCss: scalarTheme,
    hideModels: false,
    showConsole: false,
  }).replace(/'/g, "&#39;");

  return `<!doctype html>
<html>
  <head>
    <title>XReactor — API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <script
      id="api-reference"
      data-configuration='${config}'
      type="application/json"
      >${specJson}</script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}

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
        // OpenAPI reference view (Scalar), scoped to the xreactor endpoint.
        reply.type("text/html; charset=utf-8");
        return reply.send(scalarReferenceHtml(server));
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
