import { FastifyInstance } from "fastify";
import fs from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { makeCancelSignal } from "@remotion/renderer";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";
import { renderService } from "../services/RenderService.js";
import { settingsService } from "../services/SettingsService.js";
import type { RenderRequest, ErrorResponse, CaptionWord } from "@lusk/shared";

const RENDER_LOG = "/tmp/lusk-render.log";
function routeLog(msg: string): void {
  const line = `[${new Date().toISOString()}] [route] ${msg}\n`;
  console.log(`[render-route] ${msg}`);
  try { appendFileSync(RENDER_LOG, line); } catch { /* ignore */ }
}

/** Active render cancel functions, keyed by sessionId (one render per session at a time). */
const activeRenderCancels = new Map<string, { cancel: () => void; clipKey: string }>();

function clipKey(clip: { startMs: number; endMs: number }): string {
  return `${clip.startMs}-${clip.endMs}`;
}

async function runRender(
  sessionId: string,
  clip: RenderRequest["clip"],
  offsetX: number,
  log: FastifyInstance["log"],
  preProcessedCaptions?: CaptionWord[]
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

  const { cancelSignal, cancel } = makeCancelSignal();
  activeRenderCancels.set(sessionId, { cancel, clipKey: key });

  try {
    const outroConfig = await renderService.detectOutroConfig();

    const sourceAspectRatio =
      session.videoWidth != null && session.videoHeight != null
        ? session.videoWidth / session.videoHeight
        : null;

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
      preProcessedCaptions as any,
      outroConfig,
      sourceAspectRatio,
      cancelSignal
    );

    const outputUrl = `/static/${sessionId}/${outputFileName}?t=${Date.now()}`;
    orchestrator.updateClipRender(sessionId, key, {
      status: "exported",
      progress: 100,
      message: "Export complete — ready to download",
      outputUrl,
    });
  } catch (err) {
    const isCancelled = err instanceof Error && err.message.includes("cancelled");
    if (!isCancelled) {
      log.error(err, "Render failed");
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      console.error("[render] RENDER ERROR:", errMsg);
      routeLog(`runRender ERROR: ${errMsg}`);
    }
    // Delete the render entry so the clip appears retryable.
    const s = orchestrator.getSession(sessionId);
    if (s?.renders) {
      delete s.renders[key];
      orchestrator.emitAndPersist(sessionId);
    }
  } finally {
    activeRenderCancels.delete(sessionId);
  }
}

export async function renderRoute(app: FastifyInstance) {
  // Outro config endpoint: returns file paths + durations for client-side preview
  app.get("/api/outro-config", async () => {
    const config = await renderService.detectOutroConfig();
    const outroOverlapFrames = await settingsService.getOutroOverlapFrames();
    return {
      outroSrc: config?.outroSrc ?? "",
      outroDurationInFrames: config?.outroDurationInFrames ?? 0,
      outroOverlapFrames,
    };
  });

  app.post<{ Body: RenderRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/render",
    async (request, reply) => {
      const body = (request.body ?? {}) as any;
      const { sessionId, clip, offsetX, captions } = body;

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

  app.post<{ Params: { projectId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/projects/:projectId/cancel-render",
    async (request, reply) => {
      const { projectId } = request.params;
      const entry = activeRenderCancels.get(projectId);
      if (!entry) {
        return reply.send({ success: true });
      }
      entry.cancel();
      activeRenderCancels.delete(projectId);
      // Clear render entry immediately so UI updates without waiting for render to throw
      const session = orchestrator.getSession(projectId);
      if (session?.renders?.[entry.clipKey]) {
        delete session.renders[entry.clipKey];
        orchestrator.emitAndPersist(projectId);
      }
      return reply.send({ success: true });
    }
  );

  // Validate exported render entries against the actual files on disk.
  // Removes orphaned entries (file deleted while server was running) and returns
  // the fresh renders map so the client can build an accurate pending queue.
  app.post<{ Params: { projectId: string }; Reply: { renders: Record<string, unknown> } | ErrorResponse }>(
    "/api/projects/:projectId/sync-render-states",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const sessionDir = tempManager.getSessionDir(projectId);
      let changed = false;

      if (session.renders) {
        const hasActiveRender = activeRenderCancels.has(projectId);
        for (const key of Object.keys(session.renders)) {
          const entry = session.renders[key];
          if (entry.status === "exported") {
            const filePath = path.join(sessionDir, `output_${key}.mp4`);
            if (!fs.existsSync(filePath)) {
              delete session.renders[key];
              changed = true;
            }
          } else if (entry.status === "rendering" && !hasActiveRender) {
            // Render was cancelled or crashed — clear stuck state
            delete session.renders[key];
            changed = true;
          }
        }
      }

      if (changed) orchestrator.emitAndPersist(projectId);

      return reply.send({ renders: session.renders ?? {} });
    }
  );
}
