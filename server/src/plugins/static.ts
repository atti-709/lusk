import { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const TEMP_DIR = join(import.meta.dirname, "../../.lusk_temp");

export async function staticPlugin(app: FastifyInstance) {
  await mkdir(TEMP_DIR, { recursive: true });

  await app.register(fastifyStatic, {
    root: TEMP_DIR,
    prefix: "/static/",
  });
}
