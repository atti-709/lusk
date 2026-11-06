import Fastify from "fastify";
import { registerAuth } from "./auth.js";
import { uploadRoute } from "./routes/upload.js";
import { staticPlugin } from "./plugins/static.js";
import { eventsRoute } from "./routes/events.js";
import { projectRoute } from "./routes/project.js";
import { transcribeRoute, abortAllJobs } from "./routes/transcribe.js";
import { renderRoute, cancelAllRenders } from "./routes/render.js";
import { killAllGroups } from "./services/ChildProcesses.js";
import { alignRoute } from "./routes/align.js";
import { exportImportRoute } from "./routes/exportImport.js";
import { projectsRoute } from "./routes/projects.js";
import { settingsRoute } from "./routes/settings.js";
import { pythonEnvRoute } from "./routes/python-env.js";
import { pythonEnvService } from "./services/PythonEnvService.js";
import { settingsService } from "./services/SettingsService.js";
import { tempManager } from "./services/TempManager.js";
import { projectFileService } from "./services/ProjectFileService.js";

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

const PORT = parseInt(process.env.LUSK_PORT ?? "3000", 10);

// Every request must carry the per-launch token (see auth.ts). Without one the server
// refuses to start, unless auth is switched off explicitly (never the default).
const TOKEN = process.env.LUSK_TOKEN;
if (!TOKEN && process.env.LUSK_AUTH_DISABLED !== "1") {
  console.error("LUSK_TOKEN is not set. Start dev with `npm run dev` from the repo root (it makes a random one per start), or set LUSK_TOKEN yourself.");
  process.exit(1);
}
if (TOKEN) {
  await registerAuth(server, {
    token: TOKEN,
    port: PORT,
    extraOrigins: (process.env.LUSK_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  });
}
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
await server.register(pythonEnvRoute);

server.get("/api/health", async () => {
  const whisperxAvailable = pythonEnvService.isReady();
  const geminiApiKeySet = !!(await settingsService.getGeminiApiKey());
  return { status: "ok" as const, uptime: process.uptime(), whisperxAvailable, geminiApiKeySet };
});

// Clean up orphaned temp directories (sessions no longer in the registry).
const recentProjects = await projectFileService.getRecentProjects();
const knownIds = new Set(recentProjects.map((p) => p.projectId));
await tempManager.cleanupOrphaned(knownIds);

try {
  await server.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

// Node does not stop its children when it exits. Without this, quitting the app mid-job
// left WhisperX (or Remotion's headless Chrome) running with nobody to read its output.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — stopping running jobs`);
  abortAllJobs();
  cancelAllRenders();
  killAllGroups();
  // Give Remotion a moment to close its browser, then go regardless
  setTimeout(() => process.exit(0), 1500).unref();
  server.close().finally(() => setTimeout(() => process.exit(0), 300).unref());
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { server };
