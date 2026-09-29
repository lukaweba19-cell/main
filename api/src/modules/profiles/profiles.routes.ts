import fastifyMultipart from "@fastify/multipart";
import { FastifyInstance, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { ProfileService } from "../../services/profile.service.js";
import { MB } from "../../utils/size.js";
import { ProfilesController } from "./profiles.controller.js";

async function routes(server: FastifyInstance) {
  const controller = new ProfilesController(ProfileService.getInstance());

  await server.register(fastifyMultipart, {
    limits: {
      fileSize: 500 * MB,
    },
    attachFieldsToBody: false,
  });

  server.get(
    "/profiles",
    {
      schema: {
        operationId: "list_profiles",
        summary: "List all profiles",
        description: "Retrieve a list of all profiles",
        tags: ["Profiles"],
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: $ref("MultipleProfiles"),
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) =>
      controller.handleList(server, request, reply),
  );

  server.post(
    "/profiles",
    {
      schema: {
        operationId: "create_profile",
        summary: "Create a new profile",
        description: "Create a new profile with userDataDir and optional settings",
        tags: ["Profiles"],
        consumes: ["multipart/form-data"],
        body: $ref("ProfileCreateRequest"),
        response: {
          201: $ref("Profile"),
        },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (request, reply) => controller.handleCreate(server, request, reply),
  );

  server.get(
    "/profiles/:id",
    {
      schema: {
        operationId: "get_profile",
        summary: "Get a profile by ID",
        description: "Retrieve a profile by ID",
        tags: ["Profiles"],
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: $ref("Profile"),
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { projectId?: string };
      }>,
      reply,
    ) => controller.handleGet(server, request, reply),
  );

  server.patch(
    "/profiles/:id",
    {
      schema: {
        operationId: "update_profile",
        summary: "Update a profile",
        description: "Update an existing profile",
        tags: ["Profiles"],
        consumes: ["multipart/form-data"],
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
          },
        },
        body: $ref("ProfileCreateRequest"),
        response: {
          200: $ref("Profile"),
        },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { projectId?: string };
      }>,
      reply,
    ) => controller.handleUpdate(server, request, reply),
  );

  server.delete(
    "/profiles/:id",
    {
      schema: {
        operationId: "delete_profile",
        summary: "Delete a profile",
        description: "Delete a profile and its stored userDataDir archive",
        tags: ["Profiles"],
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { success: { type: "boolean" } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { projectId?: string };
      }>,
      reply,
    ) => {
      const { id } = request.params;
      const { projectId } = request.query;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.code(400).send({ success: false, message: "Invalid profile id UUID format" });
      }
      const profileService = ProfileService.getInstance();
      const profile = profileService.get(id, projectId);
      if (!profile) {
        return reply.code(404).send({ success: false, message: "Profile not found" });
      }
      // Remove the stored archive, then drop the meta entry.
      try {
        const fs = await import("fs");
        const path = await import("path");
        const base = (profileService as unknown as { basePath: string }).basePath;
        if (profile.userDataDir) {
          fs.rmSync(profile.userDataDir, { force: true });
        }
        if (base) {
          fs.rmSync(path.join(base, id), { recursive: true, force: true });
        }
        const meta = profileService as unknown as {
          readMeta(): Record<string, unknown>;
          writeMeta(m: Record<string, unknown>): void;
        };
        const all = meta.readMeta();
        delete all[id];
        meta.writeMeta(all);
      } catch {
        // best-effort cleanup
      }
      return reply.code(200).send({ success: true });
    },
  );
}

export default routes;
