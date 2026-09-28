import { FastifyRequest } from "fastify";
import { CDPService } from "../services/cdp/cdp.service.js";
import { SessionService } from "../services/session.service.js";
import { FileService } from "../services/file.service.js";

declare module "fastify" {
  interface FastifyRequest {}
  interface FastifyInstance {
    sessionService: SessionService;
    fileService: FileService;
  }
}
