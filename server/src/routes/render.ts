import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import type { RenderRequest, ErrorResponse } from "@lusk/shared";

async function runMockRender(sessionId: string): Promise<void> {
  orchestrator.transition(sessionId, "RENDERING");
  orchestrator.updateProgress(sessionId, 10, "Preparing render...");
  await delay(1000);
  orchestrator.updateProgress(sessionId, 40, "Encoding video...");
  await delay(1500);
  orchestrator.updateProgress(sessionId, 80, "Finalizing...");
  await delay(1000);
  orchestrator.updateProgress(sessionId, 100, "Render complete");
  await delay(500);

  const outputUrl = `/static/${sessionId}/output.mp4`;
  orchestrator.setOutputUrl(sessionId, outputUrl);

  orchestrator.transition(sessionId, "EXPORTED");
  orchestrator.updateProgress(sessionId, 100, "Export complete — ready to download");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renderRoute(app: FastifyInstance) {
  app.post<{ Body: RenderRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/render",
    async (request, reply) => {
      const { sessionId } = (request.body ?? {}) as Partial<RenderRequest>;

      if (!sessionId) {
        return reply.status(400).send({ success: false, error: "sessionId is required" });
      }

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      if (session.state !== "READY") {
        return reply
          .status(409)
          .send({ success: false, error: `Cannot render in state: ${session.state}` });
      }

      // Fire-and-forget
      runMockRender(sessionId).catch((err) => {
        app.log.error(err, "Mock render failed");
      });

      return { success: true as const };
    }
  );
}
