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
 * Collects schema names referenced via #/components/schemas/<Name> anywhere in
 * a JSON structure, so the docs page can include ONLY the models the xreactor
 * endpoint actually uses (not every schema registered by the full API).
 */
function collectSchemaRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((item) => collectSchemaRefs(item, found));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string") {
        const match = value.match(/^#\/components\/schemas\/([^"/]+)$/);
        if (match) found.add(match[1]);
      } else {
        collectSchemaRefs(value, found);
      }
    }
  }
}

/**
 * Standalone Scalar API-reference page — the same viewer /documentation uses —
 * with an inline OpenAPI spec stripped down to the xreactor endpoint and its
 * models only. Served when GET /xreactor is opened without a url parameter.
 */
function scalarReferenceHtml(server: FastifyInstance): string {
  const full = server.swagger() as {
    paths: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
    openapi?: string;
  };

  const xreactorPaths = full.paths["/xreactor"]
    ? { "/xreactor": full.paths["/xreactor"] }
    : {};

  // Models section shows only what this endpoint references.
  const usedSchemas = new Set<string>();
  collectSchemaRefs(xreactorPaths, usedSchemas);
  const schemas: Record<string, unknown> = {};
  for (const name of usedSchemas) {
    const schema = full.components?.schemas?.[name];
    if (schema) schemas[name] = schema;
  }

  const spec = {
    openapi: full.openapi ?? "3.0.3",
    paths: xreactorPaths,
    components: { schemas },
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

  // GET serves ONLY the docs view (hidden from the OpenAPI spec). The check
  // itself is POST-only; every GET on /xreactor — with or without ?url= —
  // shows the Scalar reference page.
  server.get(
    "/xreactor",
    {
      schema: {
        hide: true,
      },
    },
    async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      return reply.send(scalarReferenceHtml(server));
    },
  );
}

export default routes;
