import Fastify from "fastify";
import cors from "@fastify/cors";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin } from "./plugins/static.js";
import { eventsRoute } from "./routes/events.js";
import { projectRoute } from "./routes/project.js";
import { transcribeRoute } from "./routes/transcribe.js";
import { renderRoute } from "./routes/render.js";
import { alignRoute } from "./routes/align.js";
import { exportImportRoute } from "./routes/exportImport.js";
import { projectsRoute } from "./routes/projects.js";
import { settingsRoute } from "./routes/settings.js";
import { whisperService } from "./services/WhisperService.js";
import { settingsService } from "./services/SettingsService.js";

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
await server.register(exportImportRoute);
await server.register(projectsRoute);
await server.register(settingsRoute);

server.get("/api/health", async () => {
  const whisperxAvailable = await whisperService.isAvailable();
  const geminiApiKeySet = !!(await settingsService.getGeminiApiKey());
  return { status: "ok" as const, uptime: process.uptime(), whisperxAvailable, geminiApiKeySet };
});

const PORT = parseInt(process.env.LUSK_PORT ?? "3000", 10);

// Projects are loaded on-demand when opened from the dashboard.
// No startup session scanning needed.

try {
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export { server };
