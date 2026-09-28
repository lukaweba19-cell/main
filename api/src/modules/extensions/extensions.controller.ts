import { MultipartFile } from "@fastify/multipart";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as fs from "fs";
import path from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { v4 as uuidv4 } from "uuid";
import { ExtensionService } from "../../services/extension.service.js";
import { getErrors } from "../../utils/errors.js";

export class ExtensionsController {
  constructor(private extensionService: ExtensionService) {}

  async handleList(_server: FastifyInstance, _request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = this.extensionService.list();
      return reply.code(200).send(result);
    } catch (e: unknown) {
      return reply.code(500).send({
        success: false,
        message: getErrors(e),
      });
    }
  }

  async handleDeleteAll(_server: FastifyInstance, _request: FastifyRequest, reply: FastifyReply) {
    try {
      const count = this.extensionService.deleteAll();
      return reply.code(200).send({
        message: `Deleted ${count} extension(s)`,
      });
    } catch (e: unknown) {
      return reply.code(500).send({
        success: false,
        message: getErrors(e),
      });
    }
  }

  async handleCreate(server: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    let tempFilePath: string | null = null;
    try {
      if (!request.isMultipart()) {
        return reply.code(400).send({
          success: false,
          message: "Request must be multipart/form-data",
        });
      }

      let fileProvided = false;
      let fileUrl: string | null = null;
      let originalName: string | undefined;

      for await (const part of request.parts()) {
        if (part.fieldname === "file") {
          if (part.type === "file") {
            const file = part as MultipartFile;
            fileProvided = true;
            originalName = file.filename;
            tempFilePath = path.join(tmpdir(), `ext_upload_${uuidv4()}`);
            const writeStream = fs.createWriteStream(tempFilePath);
            await pipeline(file.file, writeStream);
          } else if (part.type === "field" && typeof part.value === "string") {
            // allow file field to be a URL string as well
            fileUrl = part.value;
          }
        } else if (
          part.fieldname === "url" &&
          part.type === "field" &&
          typeof part.value === "string"
        ) {
          fileUrl = part.value;
        }
      }

      if (!fileProvided && !fileUrl) {
        return reply.code(400).send({
          success: false,
          message: "Provide either a file (.zip/.crx) or a url field",
        });
      }

      let result;
      if (fileProvided && tempFilePath) {
        const readStream = fs.createReadStream(tempFilePath);
        result = await this.extensionService.createFromFile(readStream, originalName);
        await fs.promises.unlink(tempFilePath).catch(() => {});
        tempFilePath = null;
      } else if (fileUrl) {
        try {
          new URL(fileUrl);
        } catch {
          return reply.code(400).send({
            success: false,
            message: "Invalid URL provided",
          });
        }
        result = await this.extensionService.createFromUrl(fileUrl);
      }

      return reply.code(201).send(result);
    } catch (e: unknown) {
      if (tempFilePath) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }
      const msg = getErrors(e);
      if (msg.includes("not found") || msg.includes("Failed to download")) {
        return reply.code(400).send({ success: false, message: msg });
      }
      return reply.code(500).send({ success: false, message: msg });
    }
  }

  async handleGet(
    _server: FastifyInstance,
    request: FastifyRequest<{ Params: { extensionId: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const { extensionId } = request.params;
      const filePath = this.extensionService.getFilePath(extensionId);
      if (!filePath || !fs.existsSync(filePath)) {
        return reply.code(404).send({
          success: false,
          message: "Extension not found",
        });
      }
      const stats = fs.statSync(filePath);
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Length", stats.size);
      reply.header("Content-Disposition", `attachment; filename="extension-${extensionId}.zip"`);
      return reply.send(fs.createReadStream(filePath));
    } catch (e: unknown) {
      return reply.code(500).send({
        success: false,
        message: getErrors(e),
      });
    }
  }

  async handleDelete(
    _server: FastifyInstance,
    request: FastifyRequest<{ Params: { extensionId: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const { extensionId } = request.params;
      const deleted = this.extensionService.delete(extensionId);
      if (!deleted) {
        return reply.code(404).send({
          success: false,
          message: "Extension not found",
        });
      }
      return reply.code(200).send({ message: "Extension deleted successfully" });
    } catch (e: unknown) {
      return reply.code(500).send({
        success: false,
        message: getErrors(e),
      });
    }
  }

  async handleUpdate(
    server: FastifyInstance,
    request: FastifyRequest<{ Params: { extensionId: string } }>,
    reply: FastifyReply,
  ) {
    let tempFilePath: string | null = null;
    try {
      const { extensionId } = request.params;
      const existing = this.extensionService.get(extensionId);
      if (!existing) {
        return reply.code(404).send({
          success: false,
          message: "Extension not found",
        });
      }

      if (!request.isMultipart()) {
        return reply.code(400).send({
          success: false,
          message: "Request must be multipart/form-data",
        });
      }

      let fileProvided = false;
      let fileUrl: string | null = null;
      let originalName: string | undefined;

      for await (const part of request.parts()) {
        if (part.fieldname === "file") {
          if (part.type === "file") {
            const file = part as MultipartFile;
            fileProvided = true;
            originalName = file.filename;
            tempFilePath = path.join(tmpdir(), `ext_upload_${uuidv4()}`);
            const writeStream = fs.createWriteStream(tempFilePath);
            await pipeline(file.file, writeStream);
          } else if (part.type === "field" && typeof part.value === "string") {
            fileUrl = part.value;
          }
        } else if (
          part.fieldname === "url" &&
          part.type === "field" &&
          typeof part.value === "string"
        ) {
          fileUrl = part.value;
        }
      }

      if (!fileProvided && !fileUrl) {
        return reply.code(400).send({
          success: false,
          message: "Provide either a file (.zip/.crx) or a url field",
        });
      }

      let result;
      if (fileProvided && tempFilePath) {
        const readStream = fs.createReadStream(tempFilePath);
        result = await this.extensionService.updateFromFile(extensionId, readStream, originalName);
        await fs.promises.unlink(tempFilePath).catch(() => {});
        tempFilePath = null;
      } else if (fileUrl) {
        try {
          new URL(fileUrl);
        } catch {
          return reply.code(400).send({
            success: false,
            message: "Invalid URL provided",
          });
        }
        result = await this.extensionService.updateFromUrl(extensionId, fileUrl);
      }

      return reply.code(200).send(result);
    } catch (e: unknown) {
      if (tempFilePath) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }
      const msg = getErrors(e);
      if (msg.includes("not found")) {
        return reply.code(404).send({ success: false, message: msg });
      }
      return reply.code(500).send({ success: false, message: msg });
    }
  }
}
