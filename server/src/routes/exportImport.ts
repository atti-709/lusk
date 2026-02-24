import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { access } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import archiver from "archiver";
import AdmZip from "adm-zip";
import type { ProjectState, ImportResponse, ErrorResponse } from "@lusk/shared";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";

export async function exportImportRoute(app: FastifyInstance) {
  // Register multipart for the import endpoint (scoped to this plugin)
  await app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB
    },
  });

  // ── Export ──────────────────────────────────────────────────────────────
  app.get<{
    Params: { sessionId: string };
    Querystring: { includeVideo?: string };
    Reply: ErrorResponse | void;
  }>(
    "/api/project/:sessionId/export",
    async (request, reply) => {
      const { sessionId } = request.params;
      const includeVideo = request.query.includeVideo === "true";

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const sessionDir = tempManager.getSessionDir(sessionId);
      const videoName = session.videoName ?? sessionId;
      const filename = `${videoName}.lusk`;

      reply.raw.setHeader("Content-Type", "application/zip");
      reply.raw.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(filename)}"`
      );

      const archive = archiver("zip", { zlib: { level: 1 } });
      archive.pipe(reply.raw);

      // Always include session.json
      const sessionJsonPath = join(sessionDir, "session.json");
      try {
        await access(sessionJsonPath);
        archive.file(sessionJsonPath, { name: "session.json" });
      } catch {
        // session.json should always exist, but guard anyway
      }

      // Include session-meta.json if it exists
      const metaPath = join(sessionDir, "session-meta.json");
      try {
        await access(metaPath);
        archive.file(metaPath, { name: "session-meta.json" });
      } catch {
        // Optional file, skip if missing
      }

      // Include input.mp4 if requested and exists
      if (includeVideo) {
        const videoPath = join(sessionDir, "input.mp4");
        try {
          await access(videoPath);
          archive.file(videoPath, { name: "input.mp4" });
        } catch {
          // Video file missing, skip
        }
      }

      await archive.finalize();
      return reply.hijack();
    }
  );

  // ── Import ─────────────────────────────────────────────────────────────
  app.post<{ Reply: ImportResponse | ErrorResponse }>(
    "/api/import",
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

      // Read file into buffer
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk as Buffer);
      }
      const buffer = Buffer.concat(chunks);

      // Extract archive
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();

      // Find and parse session.json
      const sessionEntry = entries.find((e) => e.entryName === "session.json");
      if (!sessionEntry) {
        return reply
          .status(400)
          .send({ success: false, error: "Invalid .lusk file: missing session.json" });
      }

      let sessionData: ProjectState;
      try {
        sessionData = JSON.parse(sessionEntry.getData().toString("utf-8")) as ProjectState;
      } catch {
        return reply
          .status(400)
          .send({ success: false, error: "Invalid .lusk file: malformed session.json" });
      }

      // Create new session
      const newSessionId = tempManager.createSession();
      const sessionDir = await tempManager.ensureSessionDir(newSessionId);

      // Check if video is in the archive
      const hasVideo = entries.some((e) => e.entryName === "input.mp4");

      // Rewrite session data with new session identity
      const videoName = sessionData.videoName ?? null;
      sessionData.sessionId = newSessionId;
      sessionData.videoUrl = hasVideo ? `/static/${newSessionId}/input.mp4` : null;
      sessionData.renders = {};
      sessionData.outputUrl = null;

      if (!hasVideo) {
        sessionData.state = "IDLE";
      }

      // Write session files to new session dir
      await writeFile(
        join(sessionDir, "session.json"),
        JSON.stringify(sessionData, null, 2)
      );

      // Write session-meta.json
      const metaEntry = entries.find((e) => e.entryName === "session-meta.json");
      if (metaEntry) {
        // Rewrite meta with new session info
        const meta = {
          sessionId: newSessionId,
          state: sessionData.state,
          videoUrl: sessionData.videoUrl,
          videoName,
        };
        await writeFile(
          join(sessionDir, "session-meta.json"),
          JSON.stringify(meta)
        );
      }

      // Extract input.mp4 if present
      if (hasVideo) {
        const videoEntry = entries.find((e) => e.entryName === "input.mp4")!;
        await writeFile(join(sessionDir, "input.mp4"), videoEntry.getData());
      }

      // Register in orchestrator
      orchestrator.restoreSession(sessionData);

      return {
        success: true as const,
        sessionId: newSessionId,
        videoName,
      };
    }
  );
}
