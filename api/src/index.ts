import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySensible from "@fastify/sensible";
import steelBrowserPlugin from "./steel-browser-plugin.js";
import uiPlugin from "./plugins/ui-plugin.js";
import cdpProxyPlugin from "./plugins/cdp-proxy.js";
import { loggingConfig } from "./config.js";
import { MB } from "./utils/size.js";
import path from "node:path";
import fs from "node:fs";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export const server = fastify({
  logger: loggingConfig[process.env.NODE_ENV ?? "development"] ?? true,
  trustProxy: true,
  bodyLimit: 100 * MB,
  disableRequestLogging: true,
});

function resolveUiDistPath(): string | null {
  const candidates = [
    process.env.UI_DIST_PATH,
    path.join(process.cwd(), "ui/dist"),
    path.join(process.cwd(), "../ui/dist"),
    path.join(process.cwd(), "../../ui/dist"),
    "/root/steel-browser/ui/dist",
    "/app/ui/dist",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

const setupServer = async () => {
  await server.register(fastifySensible);
  await server.register(fastifyCors, { origin: true });

  // Register UI plugin when built UI files are available
  const uiDistPath = resolveUiDistPath();
  if (uiDistPath) {
    await server.register(uiPlugin, {
      uiDistPath,
      uiPrefix: "/ui",
    });
  } else {
    server.log.info("UI dist not found, skipping UI serving");
  }

  await server.register(steelBrowserPlugin, {
    fileStorage: {
      maxSizePerSession: 100 * MB,
    },
  });

  // CDP HTTP proxy AFTER steel plugin so cdpService can auto-launch if needed
  await server.register(cdpProxyPlugin);
};

const startServer = async () => {
  try {
    await setupServer();
    await server.listen({ port: PORT, host: HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

startServer();
