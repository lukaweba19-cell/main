import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { $ref } from "../../plugins/schemas.js";
import cdpSchemas from "./cdp.schemas.js";

async function routes(server: FastifyInstance) {
  server.get(
    "/devtools/inspector.html",
    {
      schema: {
        operationId: "getDevtoolsUrl",
        description: "Get the URL for the DevTools inspector",
        tags: ["CDP"],
        summary: "Get the URL for the DevTools inspector",
        querystring: $ref("GetDevtoolsUrlSchema"),
      },
    },
    async (
      request: FastifyRequest<{ Querystring: z.infer<typeof cdpSchemas.GetDevtoolsUrlSchema> }>,
      reply: FastifyReply,
    ) => {
      try {
        if (!server.cdpService.isRunning()) {
          return reply.code(503).send({
            success: false,
            message: "Browser is not running yet. Wait for session startup and retry.",
          });
        }
        return reply.redirect(
          `${server.cdpService.getDebuggerUrl()}?ws=${server.cdpService
            .getDebuggerWsUrl(request.query.pageId)
            .replace("ws:", "")}`,
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to resolve DevTools URL";
        return reply.code(503).send({
          success: false,
          message,
        });
      }
    },
  );
}

export default routes;
