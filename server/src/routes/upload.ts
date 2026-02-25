import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UploadResponse, ErrorResponse } from "@lusk/shared";
import { tempManager } from "../services/TempManager.js";
import { orchestrator } from "../services/Orchestrator.js";
import { renderService } from "../services/RenderService.js";

export async function uploadRoute(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB
    },
  });

  app.post<{ Reply: UploadResponse | ErrorResponse }>(
    "/api/upload",
    async (request, reply) => {
      let data;
      try {
        data = await request.file();
      } catch {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      if (!data) {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      const sessionId = tempManager.createSession();
      const sessionDir = await tempManager.ensureSessionDir(sessionId);

      const savePath = join(sessionDir, "input.mp4");
      await pipeline(data.file, createWriteStream(savePath));

      const videoUrl = `/static/${sessionId}/input.mp4`;
      // Strip extension for display; fall back to null if filename unavailable
      const rawName = data.filename ?? null;
      const videoName = rawName
        ? rawName.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").trim()
        : null;

      // Probe video duration for identity verification on re-import
      const durationSec = await renderService.probeDuration(savePath);
      const videoDurationMs = durationSec > 0 ? Math.round(durationSec * 1000) : null;

      orchestrator.createSession(sessionId, videoUrl, videoName, videoDurationMs);

      return {
        success: true as const,
        sessionId,
        fileName: "input.mp4",
        url: videoUrl,
      };
    }
  );

  // Upload video to an existing IDLE session (e.g. imported without video)
  app.post<{ Params: { sessionId: string }; Reply: UploadResponse | ErrorResponse }>(
    "/api/sessions/:sessionId/upload-video",
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = orchestrator.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (session.state !== "IDLE") {
        return reply.status(400).send({ success: false, error: "Session already has a video" });
      }

      let data;
      try {
        data = await request.file();
      } catch {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }
      if (!data) {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      const sessionDir = await tempManager.ensureSessionDir(sessionId);
      const savePath = join(sessionDir, "input.mp4");
      await pipeline(data.file, createWriteStream(savePath));

      // Verify the uploaded video matches the original by duration
      const durationSec = await renderService.probeDuration(savePath);
      const uploadedDurationMs = durationSec > 0 ? Math.round(durationSec * 1000) : null;

      if (session.videoDurationMs != null && uploadedDurationMs != null) {
        const tolerance = 500; // allow 500ms tolerance for container differences
        if (Math.abs(session.videoDurationMs - uploadedDurationMs) > tolerance) {
          // Clean up the mismatched file
          const { unlink } = await import("node:fs/promises");
          await unlink(savePath).catch(() => {});
          return reply.status(400).send({
            success: false,
            error: `Video duration mismatch: expected ~${(session.videoDurationMs / 1000).toFixed(1)}s, got ${(uploadedDurationMs / 1000).toFixed(1)}s. Please upload the same video used in the original project.`,
          });
        }
      }

      const videoUrl = `/static/${sessionId}/input.mp4`;
      const rawName = data.filename ?? null;
      const videoName = rawName
        ? rawName.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").trim()
        : null;

      // Update the session with the video and go straight to READY
      // (transcript/captions already exist from import — no need to re-transcribe)
      session.videoUrl = videoUrl;
      if (videoName) session.videoName = videoName;
      if (uploadedDurationMs != null) session.videoDurationMs = uploadedDurationMs;
      session.state = "READY";
      session.progress = 0;
      session.message = "";
      orchestrator.emitAndPersist(sessionId);

      return {
        success: true as const,
        sessionId,
        fileName: "input.mp4",
        url: videoUrl,
      };
    }
  );
}
