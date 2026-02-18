import Fastify from "fastify";
import cors from "@fastify/cors";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin } from "./plugins/static.js";
import { eventsRoute } from "./routes/events.js";
import { projectRoute } from "./routes/project.js";
import { transcribeRoute } from "./routes/transcribe.js";
import { renderRoute } from "./routes/render.js";
import { tempManager } from "./services/TempManager.js";

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });
await server.register(uploadRoute);
await server.register(staticPlugin);
await server.register(eventsRoute);
await server.register(projectRoute);
await server.register(transcribeRoute);
await server.register(renderRoute);

server.get("/api/health", async () => {
  return { status: "ok" as const, uptime: process.uptime() };
});

const PORT = 3000;

await tempManager.cleanupAll();

try {
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export { server };
