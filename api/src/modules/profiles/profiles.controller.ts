import { MultipartFile } from "@fastify/multipart";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as fs from "fs";
import path from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { v4 as uuidv4 } from "uuid";
import { ProfileService, Dimensions } from "../../services/profile.service.js";
import { getErrors } from "../../utils/errors.js";

export class ProfilesController {
  constructor(private profileService: ProfileService) {}

  async handleList(
    _server: FastifyInstance,
    request: FastifyRequest<{ Querystring: { projectId?: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const { projectId } = request.query;
      if (projectId) {
        try {
          // basic UUID check
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
            return reply
              .code(400)
              .send({ success: false, message: "Invalid projectId UUID format" });
          }
        } catch {
          return reply.code(400).send({ success: false, message: "Invalid projectId" });
        }
      }
      const result = this.profileService.list(projectId);
      return reply.code(200).send(result);
    } catch (e: unknown) {
      return reply.code(500).send({ success: false, message: getErrors(e) });
    }
  }

  async handleGet(
    _server: FastifyInstance,
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { projectId?: string };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const { id } = request.params;
      const { projectId } = request.query;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.code(400).send({ success: false, message: "Invalid profile id UUID format" });
      }
      const profile = this.profileService.get(id, projectId);
      if (!profile) {
        return reply.code(404).send({ success: false, message: "Profile not found" });
      }
      const { userDataDir, ...rest } = profile;
      return reply.code(200).send({
        ...rest,
        userDataDir: userDataDir ? true : null,
      });
    } catch (e: unknown) {
      return reply.code(500).send({ success: false, message: getErrors(e) });
    }
  }

  private async parseMultipart(request: FastifyRequest): Promise<{
    userDataDirTemp?: string;
    dimensions?: Dimensions;
    projectId?: string;
    proxyUrl?: string;
    useProxy?: string;
    userAgent?: string;
  }> {
    let userDataDirTemp: string | undefined;
    let dimensions: Dimensions | undefined;
    let projectId: string | undefined;
    let proxyUrl: string | undefined;
    let useProxy: string | undefined;
    let userAgent: string | undefined;

    for await (const part of request.parts()) {
      if (part.fieldname === "userDataDir") {
        if (part.type === "file") {
          const file = part as MultipartFile;
          userDataDirTemp = path.join(tmpdir(), `profile_ud_${uuidv4()}`);
          const writeStream = fs.createWriteStream(userDataDirTemp);
          await pipeline(file.file, writeStream);
        }
      } else if (part.type === "field" && typeof part.value === "string") {
        switch (part.fieldname) {
          case "dimensions":
            try {
              const parsed = JSON.parse(part.value);
              if (parsed && typeof parsed.width === "number" && typeof parsed.height === "number") {
                dimensions = { width: parsed.width, height: parsed.height };
              }
            } catch {
              // ignore invalid
            }
            break;
          case "projectId":
            projectId = part.value;
            break;
          case "proxyUrl":
            proxyUrl = part.value;
            break;
          case "useProxy":
            useProxy = part.value;
            break;
          case "userAgent":
            userAgent = part.value;
            break;
        }
      }
    }

    return { userDataDirTemp, dimensions, projectId, proxyUrl, useProxy, userAgent };
  }

  async handleCreate(_server: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    let tempPath: string | undefined;
    try {
      if (!request.isMultipart()) {
        return reply.code(400).send({
          success: false,
          message: "Request must be multipart/form-data",
        });
      }

      const parsed = await this.parseMultipart(request);
      tempPath = parsed.userDataDirTemp;

      if (!tempPath) {
        return reply.code(400).send({
          success: false,
          message: "userDataDir file is required",
        });
      }

      if (
        parsed.projectId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.projectId)
      ) {
        return reply.code(400).send({ success: false, message: "Invalid projectId UUID format" });
      }

      const stream = fs.createReadStream(tempPath);
      const result = await this.profileService.create({
        userDataDirStream: stream,
        dimensions: parsed.dimensions,
        projectId: parsed.projectId,
        proxyUrl: parsed.proxyUrl,
        useProxy: parsed.useProxy,
        userAgent: parsed.userAgent,
      });

      await fs.promises.unlink(tempPath).catch(() => {});
      return reply.code(201).send(result);
    } catch (e: unknown) {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
      return reply.code(500).send({ success: false, message: getErrors(e) });
    }
  }

  async handleUpdate(
    _server: FastifyInstance,
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { projectId?: string };
    }>,
    reply: FastifyReply,
  ) {
    let tempPath: string | undefined;
    try {
      const { id } = request.params;
      const { projectId: queryProjectId } = request.query;

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.code(400).send({ success: false, message: "Invalid profile id UUID format" });
      }

      if (!request.isMultipart()) {
        return reply.code(400).send({
          success: false,
          message: "Request must be multipart/form-data",
        });
      }

      const existing = this.profileService.get(id, queryProjectId);
      if (!existing) {
        return reply.code(404).send({ success: false, message: "Profile not found" });
      }

      const parsed = await this.parseMultipart(request);
      tempPath = parsed.userDataDirTemp;

      // userDataDir is required per spec for PATCH as well
      if (!tempPath) {
        return reply.code(400).send({
          success: false,
          message: "userDataDir file is required",
        });
      }

      if (
        parsed.projectId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.projectId)
      ) {
        return reply.code(400).send({ success: false, message: "Invalid projectId UUID format" });
      }

      const stream = fs.createReadStream(tempPath);
      const result = await this.profileService.update(
        id,
        {
          userDataDirStream: stream,
          dimensions: parsed.dimensions,
          projectId: parsed.projectId,
          proxyUrl: parsed.proxyUrl,
          useProxy: parsed.useProxy,
          userAgent: parsed.userAgent,
        },
        queryProjectId,
      );

      await fs.promises.unlink(tempPath).catch(() => {});
      return reply.code(200).send(result);
    } catch (e: unknown) {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
      const msg = getErrors(e);
      if (msg.includes("not found")) {
        return reply.code(404).send({ success: false, message: msg });
      }
      return reply.code(500).send({ success: false, message: msg });
    }
  }
}
