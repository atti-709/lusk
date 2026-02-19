import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";
import { renderService } from "../services/RenderService.js";
import type { RenderRequest, ErrorResponse, CaptionWord } from "@lusk/shared";

function clipKey(clip: { startMs: number; endMs: number }): string {
  return `${clip.startMs}-${clip.endMs}`;
}

async function runRender(
  sessionId: string,
  clip: RenderRequest["clip"],
  offsetX: number,
  log: FastifyInstance["log"],
  preProcessedCaptions?: CaptionWord[] // Actually these match key props of Caption
): Promise<void> {
  const key = clipKey(clip);
  const session = orchestrator.getSession(sessionId)!;
  const sessionDir = tempManager.getSessionDir(sessionId);
  const captions = session.captions ?? [];
  const outputFileName = `output_${key}.mp4`;

  orchestrator.updateClipRender(sessionId, key, {
    status: "rendering",
    progress: 0,
    message: "Starting render...",
    outputUrl: null,
  });

  try {
    await renderService.renderClip(
      sessionId,
      sessionDir,
      clip,
      offsetX,
      captions,
      (percent, message) => {
        orchestrator.updateClipRender(sessionId, key, {
          status: "rendering",
          progress: percent,
          message,
          outputUrl: null,
        });
      },
      outputFileName,
      preProcessedCaptions as any // Cast to Remotion Caption[] as they are compatible
    );

    const outputUrl = `/static/${sessionId}/${outputFileName}?t=${Date.now()}`;
    orchestrator.updateClipRender(sessionId, key, {
      status: "exported",
      progress: 100,
      message: "Export complete — ready to download",
      outputUrl,
    });
  } catch (err) {
    log.error(err, "Render failed");
    // Remove failed render entry so user can retry
    const s = orchestrator.getSession(sessionId);
    if (s?.renders) {
      delete s.renders[key];
    }
    orchestrator.updateClipRender(sessionId, key, {
      status: "rendering",
      progress: 0,
      message: "Render failed — try again",
      outputUrl: null,
    });
  }
}

export async function renderRoute(app: FastifyInstance) {
  app.post<{ Body: RenderRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/render",
    async (request, reply) => {
      const { sessionId, clip, offsetX, captions } =
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

      // Check if this clip is already being rendered
      const key = clipKey(clip);
      const existing = session.renders?.[key];
      if (existing?.status === "rendering") {
        return reply
          .status(409)
          .send({ success: false, error: "This clip is already rendering" });
      }

      // Fire-and-forget
      runRender(sessionId, clip, offsetX ?? 0, app.log, captions).catch((err) => {
        app.log.error(err, "Render pipeline failed");
      });

      return { success: true as const };
    }
  );
}
