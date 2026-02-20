import Fastify from "fastify";
import cors from "@fastify/cors";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin } from "./plugins/static.js";
import { eventsRoute } from "./routes/events.js";
import { projectRoute } from "./routes/project.js";
import { transcribeRoute } from "./routes/transcribe.js";
import { renderRoute } from "./routes/render.js";
import { alignRoute } from "./routes/align.js";
import { sessionsRoute } from "./routes/sessions.js";
import { tempManager } from "./services/TempManager.js";
import { orchestrator } from "./services/Orchestrator.js";

const server = Fastify({
  logger:
    process.env.NODE_ENV === "production"
      ? true
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
        },
});

await server.register(cors, { origin: true });
await server.register(uploadRoute);
await server.register(staticPlugin);
await server.register(eventsRoute);
await server.register(projectRoute);
await server.register(transcribeRoute);
await server.register(renderRoute);
await server.register(alignRoute);
await server.register(sessionsRoute);

server.get("/api/health", async () => {
  return { status: "ok" as const, uptime: process.uptime() };
});

const PORT = 3000;

// Restore existing sessions instead of cleaning up
const sessions = await tempManager.listSessions();
for (const summary of sessions) {
  const state = await tempManager.restoreSession(summary.sessionId);
  if (state) {
    orchestrator.restoreSession(state);
    console.log(`Restored session ${state.sessionId} (${state.state})`);
  }
}

try {
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export { server };
