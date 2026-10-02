import { FastifyInstance } from "fastify";
import fs from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { makeCancelSignal } from "@remotion/renderer";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";
import { renderService } from "../services/RenderService.js";
import { settingsService } from "../services/SettingsService.js";
import { framingService } from "../services/FramingService.js";
import type { RenderRequest, ErrorResponse, CaptionWord, ViralClip, Framing, FramingRequest, ProjectState } from "@lusk/shared";
import { getClipRenderKey, getClipRange, getFramingMode } from "@lusk/shared";

const RENDER_LOG = "/tmp/lusk-render.log";
function routeLog(msg: string): void {
  const line = `[${new Date().toISOString()}] [route] ${msg}\n`;
  console.log(`[render-route] ${msg}`);
  try { appendFileSync(RENDER_LOG, line); } catch { /* ignore */ }
}

/** Active render cancel functions, keyed by sessionId (one render per session at a time). */
const activeRenderCancels = new Map<string, { cancel: () => void; clipKey: string }>();

function clipKey(clip: ViralClip): string {
  return getClipRenderKey(clip);
}

/** Tracking only applies to a source wider than the 9:16 frame. */
function isLandscape(session: ProjectState): boolean {
  return session.videoWidth != null && session.videoHeight != null &&
    session.videoWidth / session.videoHeight > 9 / 16 + 0.01;
}

/** The framing request a clip's settings imply, or null for a fixed (manual) crop. */
function framingRequestFor(clip: ViralClip): FramingRequest | null {
  const mode = getFramingMode(clip);
  if (mode === "manual" || (mode === "pick" && clip.subjectX == null)) return null;
  const { startMs, endMs } = getClipRange(clip);
  return { startMs, endMs, mode, subjectX: clip.subjectX, subjectT: clip.subjectT };
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
  let cancelled = false;
  activeRenderCancels.set(sessionId, { cancel: () => { cancelled = true; cancel(); }, clipKey: key });

  try {
    const settings = await settingsService.load();
    const outroConfig = (settings.outroEnabled ?? true) ? await renderService.detectOutroConfig() : null;

    const sourceAspectRatio =
      session.videoWidth != null && session.videoHeight != null
        ? session.videoWidth / session.videoHeight
        : null;

    // Tracked framing is solved here rather than trusted from the client, so batch
    // renders (Render All) track too; the preview's solve is reused from the cache
    let framing: Framing | null = null;
    const framingReq = isLandscape(session) ? framingRequestFor(clip) : null;
    if (framingReq) {
      framing = await framingService.getFraming(
        { sessionId, width: session.videoWidth!, height: session.videoHeight! },
        framingReq,
        {
          onProgress: (percent, message) => orchestrator.updateClipRender(sessionId, key, {
            status: "rendering",
            progress: Math.round(percent * 0.05),
            message,
            outputUrl: null,
          }),
        },
      );
      // A cancel that arrived while tracking ran has nothing in Remotion to stop yet
      if (cancelled) throw new Error("Render cancelled");
    }

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
      cancelSignal,
      framing?.keyframes ?? null
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
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[render] RENDER ERROR:", errMsg);
      routeLog(`runRender ERROR: ${errMsg}`);
      orchestrator.updateClipRender(sessionId, key, {
        status: "error",
        progress: 0,
        message: errMsg,
        outputUrl: null,
      });
    } else {
      // Cancelled — delete the render entry so the clip appears retryable
      const s = orchestrator.getSession(sessionId);
      if (s?.renders) {
        delete s.renders[key];
        orchestrator.emitAndPersist(sessionId);
      }
    }
  } finally {
    activeRenderCancels.delete(sessionId);
  }
}

/** Cancel every in-flight render — Remotion then stops its browser and compositor. */
export function cancelAllRenders(): void {
  for (const { cancel } of activeRenderCancels.values()) cancel();
  activeRenderCancels.clear();
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

  // Solve (or fetch the cached) tracked camera path for a clip range — the Studio preview
  app.post<{ Params: { projectId: string }; Body: FramingRequest; Reply: Framing | ErrorResponse }>(
    "/api/projects/:projectId/framing",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);
      if (!session) return reply.status(404).send({ success: false, error: "Session not found" });
      if (!isLandscape(session)) {
        return reply.status(409).send({ success: false, error: "Tracking needs a landscape source" });
      }
      const body = (request.body ?? {}) as Partial<FramingRequest>;
      const { startMs, endMs, mode, subjectX, subjectT } = body;
      if (startMs == null || endMs == null || endMs <= startMs || !mode || !["face", "pick", "speaker"].includes(mode)) {
        return reply.status(400).send({ success: false, error: "startMs, endMs and a tracking mode are required" });
      }
      if (mode === "pick" && (subjectX == null || subjectX < 0 || subjectX > 1)) {
        return reply.status(400).send({ success: false, error: "pick mode needs subjectX in [0, 1]" });
      }
      try {
        return await framingService.getFraming(
          { sessionId: projectId, width: session.videoWidth!, height: session.videoHeight! },
          { startMs, endMs, mode, subjectX, subjectT },
          { preview: true },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("cancelled")) return reply.status(409).send({ success: false, error: "Superseded" });
        request.log.error(err, "Speaker tracking failed");
        return reply.status(500).send({ success: false, error: message });
      }
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
