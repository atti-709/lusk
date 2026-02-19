import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";
import { renderService } from "../services/RenderService.js";
import type { RenderRequest, ErrorResponse } from "@lusk/shared";

async function runRender(
  sessionId: string,
  clip: RenderRequest["clip"],
  offsetX: number,
  log: FastifyInstance["log"]
): Promise<void> {
  orchestrator.transition(sessionId, "RENDERING");

  const session = orchestrator.getSession(sessionId)!;
  const sessionDir = tempManager.getSessionDir(sessionId);
  const captions = session.captions ?? [];

  try {
    await renderService.renderClip(
      sessionId,
      sessionDir,
      clip,
      offsetX,
      captions,
      (percent, message) => {
        orchestrator.updateProgress(sessionId, percent, message);
      }
    );

    const outputUrl = `/static/${sessionId}/output.mp4`;
    orchestrator.setOutputUrl(sessionId, outputUrl);
    orchestrator.transition(sessionId, "EXPORTED");
    orchestrator.updateProgress(sessionId, 100, "Export complete — ready to download");
  } catch (err) {
    log.error(err, "Render failed");
    orchestrator.updateProgress(sessionId, 0, "Render failed");
    orchestrator.transition(sessionId, "READY");
  }
}

export async function renderRoute(app: FastifyInstance) {
  app.post<{ Body: RenderRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/render",
    async (request, reply) => {
      const { sessionId, clip, offsetX } =
        (request.body ?? {}) as Partial<RenderRequest>;

      if (!sessionId || !clip) {
        return reply
          .status(400)
          .send({ success: false, error: "sessionId and clip are required" });
      }

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply
          .status(404)
          .send({ success: false, error: "Session not found" });
      }

      if (session.state !== "READY") {
        return reply
          .status(409)
          .send({
            success: false,
            error: `Cannot render in state: ${session.state}`,
          });
      }

      // Fire-and-forget
      runRender(sessionId, clip, offsetX ?? 0, app.log).catch((err) => {
        app.log.error(err, "Render pipeline failed");
      });

      return { success: true as const };
    }
  );
}
