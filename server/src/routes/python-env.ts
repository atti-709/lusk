import type { FastifyPluginAsync } from "fastify";
import { pythonEnvService } from "../services/PythonEnvService.js";

export const pythonEnvRoute: FastifyPluginAsync = async (server) => {
  // Status check — fast, no side effects
  server.get("/api/python-env/status", async () => {
    return {
      ready: pythonEnvService.isReady(),
      envPath: pythonEnvService.envDir,
    };
  });

  // Setup — SSE stream that drives the full installation
  server.post("/api/python-env/setup", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (data: { step: string; percent: number; message: string }) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // If already set up, short-circuit
    if (pythonEnvService.isReady()) {
      send({ step: "done", percent: 100, message: "Already set up" });
      reply.raw.end();
      return reply;
    }

    // Reject concurrent setup requests
    if (pythonEnvService.isSettingUp) {
      send({ step: "error", percent: 0, message: "Setup already in progress" });
      reply.raw.end();
      return reply;
    }

    try {
      await pythonEnvService.setup((step, percent, message) => {
        send({ step, percent, message });
      });
    } catch (err: any) {
      send({ step: "error", percent: 0, message: err.message ?? "Setup failed" });
    }

    reply.raw.end();
    return reply;
  });
};
