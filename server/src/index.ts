import Fastify from "fastify";
import cors from "@fastify/cors";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin, TEMP_DIR } from "./plugins/static.js";

async function cleanupSessions() {
  let entries;
  try {
    entries = await readdir(TEMP_DIR, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist yet, nothing to clean
  }

  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map((e) => rm(join(TEMP_DIR, e.name), { recursive: true, force: true }))
  );
}

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });
await server.register(uploadRoute);
await server.register(staticPlugin);

server.get("/api/health", async () => {
  return { status: "ok" as const, uptime: process.uptime() };
});

const PORT = 3000;

await cleanupSessions();

try {
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export { server };
