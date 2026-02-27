import { FastifyInstance } from "fastify";
import { readdir } from "node:fs/promises";
import type { ErrorResponse } from "@lusk/shared";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";

export async function exportImportRoute(app: FastifyInstance) {
  // ── Rendered Clips List ──────────────────────────────────────────────────
  app.get<{
    Params: { projectId: string };
    Reply: ErrorResponse | { success: true; clips: { url: string; filename: string }[] };
  }>(
    "/api/projects/:projectId/rendered-clips",
    async (request, reply) => {
      const { projectId } = request.params;

      const session = orchestrator.getSession(projectId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const sessionDir = tempManager.getSessionDir(projectId);

      // Find all rendered clip files in session dir
      let allFiles: string[];
      try {
        allFiles = await readdir(sessionDir);
      } catch {
        return reply.status(404).send({ success: false, error: "No rendered clips found" });
      }

      const clipFiles = allFiles.filter(
        (f) => f.startsWith("output_") && f.endsWith(".mp4")
      );

      if (clipFiles.length === 0) {
        return reply.status(404).send({ success: false, error: "No rendered clips found" });
      }

      // Build a map from effective render key → clip title
      const CAPTION_DELAY_MS = 900;
      const nameMap = new Map<string, string>();
      for (const clip of session.viralClips ?? []) {
        const effectiveStart = clip.startMs + (clip.trimStartDelta ?? 0);
        const effectiveEnd = clip.endMs + (clip.trimEndDelta ?? CAPTION_DELAY_MS);
        const key = `${effectiveStart}-${effectiveEnd}`;
        // Sanitize title for use as a filename
        const safeName = clip.title.replace(/[^\w\s\-]/g, "_").trim().slice(0, 60) || key;
        nameMap.set(key, safeName);
      }

      // Return URLs and friendly names for each rendered clip
      const clips: { url: string; filename: string }[] = [];
      for (const filename of clipFiles) {
        const key = filename.slice("output_".length, -".mp4".length);
        const title = nameMap.get(key) ?? key;
        clips.push({
          url: `/static/${projectId}/${filename}`,
          filename: `${title}.mp4`,
        });
      }

      return reply.send({ success: true, clips });
    }
  );
}
