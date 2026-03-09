import { FastifyInstance } from "fastify";
import { mkdir } from "node:fs/promises";
import fastifyStatic from "@fastify/static";
import { tempManager } from "../services/TempManager.js";
import { getClientPublicDir } from "../config/paths.js";
import { getConfigDir } from "../services/SettingsService.js";

export async function staticPlugin(app: FastifyInstance) {
  await tempManager.init();

  await app.register(fastifyStatic, {
    root: tempManager.baseDir,
    prefix: "/static/",
  });

  // Serve ~/.lusk/ so uploaded outro and other config assets are accessible via HTTP
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: configDir,
    prefix: "/config-assets/",
    decorateReply: false,
  });

  // Serve client/public/ so Remotion can fetch assets (e.g. outro.mp4) via HTTP
  const publicDir = getClientPublicDir();

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/public/",
    decorateReply: false, // avoid double-decorating sendFile
  });

  // In production (Electron), serve the built Vite client at /
  const clientDist = process.env.LUSK_CLIENT_DIST;
  if (clientDist) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
      decorateReply: false,
      wildcard: false, // let explicit API routes take priority
    });

    // SPA fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      return reply.sendFile("index.html", clientDist);
    });
  }
}
