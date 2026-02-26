import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin } from "./plugins/static.js";
import { eventsRoute } from "./routes/events.js";
import { projectRoute } from "./routes/project.js";
import { transcribeRoute, doTranscribe } from "./routes/transcribe.js";
import { renderRoute } from "./routes/render.js";
import { alignRoute } from "./routes/align.js";
import { sessionsRoute } from "./routes/sessions.js";
import { exportImportRoute } from "./routes/exportImport.js";
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
await server.register(exportImportRoute);

server.get("/api/health", async () => {
  return { status: "ok" as const, uptime: process.uptime() };
});

const PORT = parseInt(process.env.LUSK_PORT ?? "3000", 10);

// Restore existing sessions instead of cleaning up
const sessions = await tempManager.listSessions();
for (const summary of sessions) {
  const state = await tempManager.restoreSession(summary.sessionId);
  if (state) {
    // Clear any renders stuck "rendering" — they can't be in-progress after restart.
    // Also clear "exported" entries whose file was manually deleted from disk,
    // so Render All will correctly re-render them.
    if (state.renders) {
      const sessionDir = tempManager.getSessionDir(state.sessionId);
      for (const key of Object.keys(state.renders)) {
        const r = state.renders[key];
        if (r.status === "rendering") {
          delete state.renders[key];
        } else if (r.status === "exported") {
          const filePath = `${sessionDir}/output_${key}.mp4`;
          if (!fs.existsSync(filePath)) {
            delete state.renders[key];
          }
        }
      }
    }
    orchestrator.restoreSession(state);
    console.log(`Restored session ${state.sessionId} (${state.state})`);

    // If the server was killed mid-transcription, restart it automatically
    if (state.state === "TRANSCRIBING") {
      console.log(`Restarting transcription for session ${state.sessionId}`);
      doTranscribe(state.sessionId, server.log).catch((err) => {
        server.log.error(err, `Transcription restart failed for ${state.sessionId}`);
      });
    }
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
