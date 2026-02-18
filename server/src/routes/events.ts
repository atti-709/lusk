import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import type { ProgressEvent } from "@lusk/shared";

export async function eventsRoute(app: FastifyInstance) {
  app.get<{ Params: { sessionId: string } }>(
    "/api/events/:sessionId",
    async (request, reply) => {
      const { sessionId } = request.params;

      const session = orchestrator.toProjectState(sessionId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send current state immediately
      raw.write(`data: ${JSON.stringify(session)}\n\n`);

      const onProgress = (event: ProgressEvent) => {
        if (event.sessionId === sessionId) {
          const state = orchestrator.toProjectState(sessionId);
          if (state) {
            raw.write(`data: ${JSON.stringify(state)}\n\n`);
          }
        }
      };

      orchestrator.on("progress", onProgress);

      request.raw.on("close", () => {
        orchestrator.off("progress", onProgress);
        raw.end();
      });

      // Prevent Fastify from sending its own response
      return reply.hijack();
    }
  );
}
