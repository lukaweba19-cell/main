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
        querystring: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const url = (request.query as any)?.url as string | undefined;
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
