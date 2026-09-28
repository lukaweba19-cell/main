import fastifyMultipart from "@fastify/multipart";
import { FastifyInstance, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { ExtensionService } from "../../services/extension.service.js";
import { MB } from "../../utils/size.js";
import { ExtensionsController } from "./extensions.controller.js";

async function routes(server: FastifyInstance) {
  const controller = new ExtensionsController(ExtensionService.getInstance());

  await server.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * MB,
    },
    attachFieldsToBody: false,
  });

  server.get(
    "/extensions",
    {
      schema: {
        operationId: "list_extensions",
        summary: "List all extensions",
        description: "List all extensions for the organization/instance",
        tags: ["Extensions"],
        response: {
          200: $ref("MultipleExtensions"),
        },
      },
    },
    async (request, reply) => controller.handleList(server, request, reply),
  );

  server.delete(
    "/extensions",
    {
      schema: {
        operationId: "delete_all_extensions",
        summary: "Delete all extensions",
        description: "Delete all extensions for the organization/instance",
        tags: ["Extensions"],
        response: {
          200: $ref("ExtensionMessage"),
        },
      },
    },
    async (request, reply) => controller.handleDeleteAll(server, request, reply),
  );

  server.post(
    "/extensions",
    {
      schema: {
        operationId: "upload_extension",
        summary: "Upload a Chrome extension",
        description: "Upload a Chrome extension (.zip/.crx file or Chrome Web Store URL)",
        tags: ["Extensions"],
        consumes: ["multipart/form-data"],
        body: $ref("ExtensionUploadRequest"),
        response: {
          201: $ref("Extension"),
        },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (request, reply) => controller.handleCreate(server, request, reply),
  );

  server.get(
    "/extensions/:extensionId",
    {
      schema: {
        operationId: "download_extension",
        summary: "Download an extension",
        description: "Download an extension file by extension ID",
        tags: ["Extensions"],
        params: {
          type: "object",
          properties: {
            extensionId: { type: "string", format: "uuid" },
          },
          required: ["extensionId"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { extensionId: string } }>, reply) =>
      controller.handleGet(server, request, reply),
  );

  server.delete(
    "/extensions/:extensionId",
    {
      schema: {
        operationId: "delete_extension",
        summary: "Delete an extension",
        description: "Delete an extension by ID",
        tags: ["Extensions"],
        params: {
          type: "object",
          properties: {
            extensionId: { type: "string", format: "uuid" },
          },
          required: ["extensionId"],
        },
        response: {
          200: $ref("ExtensionMessage"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { extensionId: string } }>, reply) =>
      controller.handleDelete(server, request, reply),
  );

  server.put(
    "/extensions/:extensionId",
    {
      schema: {
        operationId: "update_extension",
        summary: "Update a Chrome extension",
        description: "Update a Chrome extension (.zip/.crx file or Chrome Web Store URL)",
        tags: ["Extensions"],
        consumes: ["multipart/form-data"],
        params: {
          type: "object",
          properties: {
            extensionId: { type: "string", format: "uuid" },
          },
          required: ["extensionId"],
        },
        body: $ref("ExtensionUploadRequest"),
        response: {
          200: $ref("Extension"),
        },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (request: FastifyRequest<{ Params: { extensionId: string } }>, reply) =>
      controller.handleUpdate(server, request, reply),
  );
}

export default routes;
