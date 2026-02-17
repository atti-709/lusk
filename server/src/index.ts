import Fastify from "fastify";
import cors from "@fastify/cors";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin } from "./plugins/static.js";

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });
await server.register(uploadRoute);
await server.register(staticPlugin);

server.get("/api/health", async () => {
  return { status: "ok" as const, uptime: process.uptime() };
});

const PORT = 3001;

try {
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export { server };
