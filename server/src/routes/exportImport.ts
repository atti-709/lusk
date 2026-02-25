import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { access, stat, readdir } from "node:fs/promises";
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

      // Collect files to archive and pre-calculate total size for Content-Length
      const filesToArchive: { path: string; name: string }[] = [];

      const sessionJsonPath = join(sessionDir, "session.json");
      try { await access(sessionJsonPath); filesToArchive.push({ path: sessionJsonPath, name: "session.json" }); } catch {}

      const metaPath = join(sessionDir, "session-meta.json");
      try { await access(metaPath); filesToArchive.push({ path: metaPath, name: "session-meta.json" }); } catch {}

      if (includeVideo) {
        const videoPath = join(sessionDir, "input.mp4");
        try { await access(videoPath); filesToArchive.push({ path: videoPath, name: "input.mp4" }); } catch {}
      }

      // Estimate zip size: with zlib level 1 on already-compressed video,
      // the output is roughly the sum of file sizes + zip overhead per entry.
      // We use archiver in "store" mode (level 0) for video to make Content-Length predictable.
      let estimatedSize = 22; // End-of-central-directory record
      for (const f of filesToArchive) {
        const s = await stat(f.path);
        // Local file header (30) + name + data descriptor (16) + central dir entry (46) + name
        estimatedSize += 30 + f.name.length + s.size + 16 + 46 + f.name.length;
      }

      reply.raw.setHeader("Content-Type", "application/zip");
      reply.raw.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(filename)}"`
      );

      // Use store (no compression) so Content-Length is predictable
      const archive = archiver("zip", { store: true });
      reply.raw.setHeader("Content-Length", estimatedSize);
      archive.pipe(reply.raw);

      for (const f of filesToArchive) {
        archive.file(f.path, { name: f.name });
      }

      await archive.finalize();
      return reply.hijack();
    }
  );

  // ── Clips ZIP ───────────────────────────────────────────────────────────
  app.get<{
    Params: { sessionId: string };
    Reply: ErrorResponse | void;
  }>(
    "/api/sessions/:sessionId/clips-zip",
    async (request, reply) => {
      const { sessionId } = request.params;

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const sessionDir = tempManager.getSessionDir(sessionId);

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
      // The render key = `${trimmedStartMs}-${trimmedEndMs}` where:
      //   trimmedStartMs = clip.startMs + (clip.trimStartDelta ?? 0)
      //   trimmedEndMs   = clip.endMs   + (clip.trimEndDelta  ?? 900)
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

      // Build file list with friendly names
      const filesToArchive: { path: string; name: string }[] = [];
      for (const filename of clipFiles) {
        // filename = output_${key}.mp4  →  key = everything between "output_" and ".mp4"
        const key = filename.slice("output_".length, -".mp4".length);
        const title = nameMap.get(key) ?? key;
        filesToArchive.push({
          path: join(sessionDir, filename),
          name: `${title}.mp4`,
        });
      }

      // Pre-calculate Content-Length (store mode = no compression, predictable size)
      let estimatedSize = 22; // end-of-central-directory record
      for (const f of filesToArchive) {
        const s = await stat(f.path);
        const nameBytes = Buffer.byteLength(f.name, "utf8");
        estimatedSize += 30 + nameBytes + s.size + 16 + 46 + nameBytes;
      }

      reply.raw.setHeader("Content-Type", "application/zip");
      reply.raw.setHeader("Content-Disposition", `attachment; filename="clips.zip"`);
      reply.raw.setHeader("Content-Length", estimatedSize);

      const archive = archiver("zip", { store: true });
      archive.pipe(reply.raw);

      for (const f of filesToArchive) {
        archive.file(f.path, { name: f.name });
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

      // Build a unique name by comparing against all existing sessions
      const existingNames = new Set(
        [...orchestrator["sessions"].values()]
          .map((s) => s.videoName)
          .filter(Boolean) as string[]
      );

      const rawName = sessionData.videoName ?? null;
      let uniqueName = rawName;
      if (rawName && existingNames.has(rawName)) {
        let n = 2;
        while (existingNames.has(`${rawName} (${n})`)) n++;
        uniqueName = `${rawName} (${n})`;
      }

      // Rewrite session data with new session identity
      const videoName = uniqueName;
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
