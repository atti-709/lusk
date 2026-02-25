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
  await app.register(fastifyStatic, {
    root: path.resolve(import.meta.dirname, "../../../client/public"),
    prefix: "/public/",
    decorateReply: false, // avoid double-decorating sendFile
  });
}
