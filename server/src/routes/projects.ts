import { execSync } from "node:child_process";
import type { FastifyPluginAsync } from "fastify";
import { getFFmpegPath } from "../config/ffmpeg.js";
import type {
  BrowseRequest,
  BrowseResponse,
  CreateProjectResponse,
  OpenProjectResponse,
  RecentProject,
  ErrorResponse,
} from "@lusk/shared";
import { orchestrator } from "../services/Orchestrator.js";
import { projectFileService } from "../services/ProjectFileService.js";
import { tempManager } from "../services/TempManager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Probe video duration in ms. Tries ffprobe, falls back to ffmpeg. */
function probeVideoDurationMs(filePath: string): number | null {
  try {
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    const stdout = execSync(
      `${JSON.stringify(ffprobe)} -v quiet -print_format json -show_format ${JSON.stringify(filePath)}`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const info = JSON.parse(stdout);
    const sec = parseFloat(info.format?.duration ?? "0");
    if (sec > 0) return Math.round(sec * 1000);
  } catch { /* ffprobe not available */ }

  // Fallback: parse duration from ffmpeg -i stderr
  try {
    const ffmpeg = getFFmpegPath();
    const stderr = (() => {
      try { execSync(`${JSON.stringify(ffmpeg)} -i ${JSON.stringify(filePath)}`, { encoding: "utf-8", timeout: 15_000 }); }
      catch (e: any) { return e.stderr ?? ""; }
      return "";
    })();
    const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) {
      const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      if (sec > 0) return Math.round(sec * 1000);
    }
  } catch { /* ignore */ }

  return null;
}

/** Probe video width and height (first video stream). Returns null values on failure. */
function probeVideoMeta(filePath: string): { width: number | null; height: number | null } {
  try {
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    const stdout = execSync(
      `${JSON.stringify(ffprobe)} -v quiet -print_format json -show_streams -select_streams v:0 ${JSON.stringify(filePath)}`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const info = JSON.parse(stdout);
    const stream = info.streams?.[0];
    const w = stream?.width;
    const h = stream?.height;
    return {
      width: typeof w === "number" && w > 0 ? w : null,
      height: typeof h === "number" && h > 0 ? h : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const projectsRoute: FastifyPluginAsync = async (server) => {
  // -------------------------------------------------------------------------
  // POST /api/browse — stub for native file dialog (Electron IPC comes later)
  // -------------------------------------------------------------------------
  server.post<{ Body: BrowseRequest; Reply: BrowseResponse }>(
    "/api/browse",
    async (_request, reply) => {
      return reply.send({ canceled: true, filePath: null });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/create
  // -------------------------------------------------------------------------
  server.post<{
    Body: { projectPath: string; videoPath?: string };
    Reply: CreateProjectResponse | ErrorResponse;
  }>("/api/projects/create", async (request, reply) => {
    try {
      const { projectPath, videoPath } = request.body;
      const state = await projectFileService.createProject(
        projectPath,
        videoPath,
      );
      orchestrator.restoreSession(state);
      return reply.send({ success: true, projectId: state.projectId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, "Failed to create project");
      return reply
        .status(500)
        .send({ success: false, error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/open
  // -------------------------------------------------------------------------
  server.post<{
    Body: { projectPath: string };
    Reply: OpenProjectResponse | ErrorResponse;
  }>("/api/projects/open", async (request, reply) => {
    try {
      const { projectPath } = request.body;
      const state = await projectFileService.openProject(projectPath);
      orchestrator.restoreSession(state);
      return reply.send({
        success: true,
        projectId: state.projectId,
        videoName: state.videoName || null,
        state: state.state,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, "Failed to open project");
      return reply
        .status(500)
        .send({ success: false, error: message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/recent
  // -------------------------------------------------------------------------
  server.get<{ Reply: RecentProject[] }>(
    "/api/projects/recent",
    async (_request, _reply) => {
      return projectFileService.getRecentProjects();
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/projects/recent/:projectId
  // -------------------------------------------------------------------------
  server.delete<{
    Params: { projectId: string };
    Reply: { success: true } | ErrorResponse;
  }>("/api/projects/recent/:projectId", async (request, reply) => {
    try {
      const { projectId } = request.params;
      await projectFileService.removeFromRegistry(projectId);
      await tempManager.cleanupSession(projectId);
      return reply.send({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, "Failed to remove from registry");
      return reply
        .status(500)
        .send({ success: false, error: message });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/projects/:projectId/cache
  // -------------------------------------------------------------------------
  server.delete<{
    Params: { projectId: string };
    Reply: { success: true } | ErrorResponse;
  }>("/api/projects/:projectId/cache", async (request, reply) => {
    try {
      const { projectId } = request.params;
      await tempManager.cleanupSessionCache(projectId);
      return reply.send({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, "Failed to clear cache");
      return reply
        .status(500)
        .send({ success: false, error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:projectId/select-video
  // -------------------------------------------------------------------------
  server.post<{
    Params: { projectId: string };
    Body: { videoPath: string };
    Reply: { success: true } | ErrorResponse;
  }>("/api/projects/:projectId/select-video", async (request, reply) => {
    try {
      const { projectId } = request.params;
      const { videoPath } = request.body;

      const session = orchestrator.getSession(projectId);
      if (!session) {
        return reply
          .status(404)
          .send({ success: false, error: "Session not found" });
      }

      // Set up cache (symlink / copy video into temp dir)
      await projectFileService.setupCache(projectId, videoPath);

      // Update session fields
      session.videoPath = videoPath;
      session.videoUrl = `/static/${projectId}/input.mp4`;
      session.videoDurationMs = probeVideoDurationMs(videoPath);
      const meta = probeVideoMeta(videoPath);
      session.videoWidth = meta.width;
      session.videoHeight = meta.height;
      session.state = "UPLOADING";
      session.progress = 100;
      session.message = "Video selected";

      orchestrator.emitAndPersist(projectId);

      return reply.send({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, "Failed to select video");
      return reply
        .status(500)
        .send({ success: false, error: message });
    }
  });
};
