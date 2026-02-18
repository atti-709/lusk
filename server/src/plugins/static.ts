import { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { tempManager } from "../services/TempManager.js";

export async function staticPlugin(app: FastifyInstance) {
  await tempManager.init();

  await app.register(fastifyStatic, {
    root: tempManager.baseDir,
    prefix: "/static/",
  });
}
