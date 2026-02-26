import { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { tempManager } from "../services/TempManager.js";

export async function staticPlugin(app: FastifyInstance) {
  await tempManager.init();

  await app.register(fastifyStatic, {
    root: tempManager.baseDir,
    prefix: "/static/",
  });

  // Serve client/public/ so Remotion can fetch assets (e.g. outro.mp4) via HTTP
  const publicDir =
    process.env.LUSK_PUBLIC_DIR ??
    path.resolve(import.meta.dirname, "../../../client/public");

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
