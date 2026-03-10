import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  symlink,
  readlink,
  copyFile,
  access,
  unlink,
} from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import AdmZip from "adm-zip";
import type {
  ProjectData,
  ProjectState,
  RecentProject,
  PipelineState,
} from "@lusk/shared";
import { tempManager } from "./TempManager.js";

const MAX_RECENT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRegistryDir(): string {
  return process.env.LUSK_REGISTRY_DIR ?? join(homedir(), ".lusk");
}

function getRegistryPath(): string {
  return join(getRegistryDir(), "recent-projects.json");
}

/** Sanitize a filename into a human-friendly video name (matches upload.ts). */
function sanitizeVideoName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]/g, " ")
    .trim();
}

/** Probe video duration in milliseconds using ffprobe. Returns null on failure. */
function probeVideoDurationMs(filePath: string): number | null {
  try {
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    const stdout = execSync(
      `${JSON.stringify(ffprobe)} -v quiet -print_format json -show_format ${JSON.stringify(filePath)}`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const info = JSON.parse(stdout);
    const sec = parseFloat(info.format?.duration ?? "0");
    return sec > 0 ? Math.round(sec * 1000) : null;
  } catch {
    return null;
  }
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

/** Generate a small JPEG thumbnail from a video, returned as a base64 data URL. */
function generateThumbnail(videoPath: string): string | null {
  try {
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    // Extract a single frame at 1 second (or start if shorter), scale to 160px wide
    const buf = execSync(
      `${JSON.stringify(ffmpeg)} -y -ss 1 -i ${JSON.stringify(videoPath)} -frames:v 1 -vf "scale=160:-2" -f image2 -c:v mjpeg -q:v 8 pipe:1`,
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
    );
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// .lusk ZIP I/O
// ---------------------------------------------------------------------------

function writeLuskFile(filePath: string, data: ProjectData): void {
  const zip = new AdmZip();
  zip.addFile("project.json", Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
  zip.writeZip(filePath);
}

function readLuskFile(filePath: string): ProjectData {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry("project.json");
  if (!entry) {
    throw new Error("Invalid .lusk file: missing project.json");
  }
  const raw = entry.getData().toString("utf-8");
  return JSON.parse(raw) as ProjectData;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

async function readRegistry(): Promise<RecentProject[]> {
  try {
    const raw = await readFile(getRegistryPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRegistry(entries: RecentProject[]): Promise<void> {
  const dir = getRegistryDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getRegistryPath(), JSON.stringify(entries, null, 2), "utf-8");
}

async function addToRegistry(entry: RecentProject): Promise<void> {
  let entries = await readRegistry();
  // Remove existing entry for this project (by path, since id may differ on re-save)
  entries = entries.filter((e) => e.projectPath !== entry.projectPath);
  // Prepend (most recent first)
  entries.unshift(entry);
  // Cap at MAX_RECENT
  if (entries.length > MAX_RECENT) {
    entries = entries.slice(0, MAX_RECENT);
  }
  await writeRegistry(entries);
}

async function updateRegistryEntry(
  projectPath: string,
  patch: Partial<Omit<RecentProject, "projectId" | "projectPath">>,
): Promise<void> {
  const entries = await readRegistry();
  const idx = entries.findIndex((e) => e.projectPath === projectPath);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...patch };
    // Move to front (LRU)
    const [updated] = entries.splice(idx, 1);
    entries.unshift(updated);
    await writeRegistry(entries);
  }
}

// ---------------------------------------------------------------------------
// Cache setup
// ---------------------------------------------------------------------------

async function setupCache(
  projectId: string,
  videoPath: string,
): Promise<string> {
  const cacheDir = await tempManager.ensureSessionDir(projectId);
  const linkPath = join(cacheDir, "input.mp4");

  // Check if symlink already exists and points to the right target
  try {
    const existingTarget = await readlink(linkPath);
    if (existingTarget === videoPath) {
      return cacheDir;
    }
    // Wrong target – remove and re-create
    await unlink(linkPath);
  } catch {
    // No existing symlink – that's fine
  }

  // Try symlink first; fall back to copy for cross-volume
  try {
    await symlink(videoPath, linkPath);
  } catch {
    await copyFile(videoPath, linkPath);
  }

  return cacheDir;
}

// ---------------------------------------------------------------------------
// Build ProjectState from ProjectData
// ---------------------------------------------------------------------------

function buildProjectState(
  data: ProjectData,
  opts: {
    videoUrl: string | null;
    projectFilePath: string | null;
    stateOverride?: PipelineState;
  },
): ProjectState {
  const resolvedState = opts.stateOverride ?? data.state;
  // ALIGNING is a manual step — restore at 100% so the AlignStep UI is shown
  const progress = resolvedState === "ALIGNING" ? 100 : 0;
  const message = resolvedState === "ALIGNING"
    ? "Transcript ready — download and correct with Gemini"
    : "";

  return {
    ...data,
    state: resolvedState,
    sessionId: data.projectId,
    videoUrl: opts.videoUrl,
    progress,
    message,
    renders: {},
    outputUrl: null,
    projectFilePath: opts.projectFilePath,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

class ProjectFileService {
  /**
   * Create a new .lusk project, optionally with a source video file.
   * Writes the .lusk ZIP, sets up the cache (if video provided), and registers the project.
   */
  async createProject(
    projectFilePath: string,
    videoPath?: string,
  ): Promise<ProjectState> {
    const projectId = randomUUID();
    const now = new Date().toISOString();

    const hasVideo = !!videoPath;
    const videoName = hasVideo ? sanitizeVideoName(basename(videoPath)) : "";
    const videoDurationMs = hasVideo ? probeVideoDurationMs(videoPath) : null;

    const data: ProjectData = {
      version: 1,
      projectId,
      createdAt: now,
      updatedAt: now,
      videoPath: videoPath ?? "",
      videoName,
      videoDurationMs,
      videoWidth: null,
      videoHeight: null,
      state: hasVideo ? "UPLOADING" : "IDLE",
      transcript: null,
      originalTranscript: null,
      correctedTranscriptRaw: null,
      scriptText: null,
      captions: null,
      viralClips: null,
    };

    // Write .lusk ZIP
    await mkdir(dirname(projectFilePath), { recursive: true });
    writeLuskFile(projectFilePath, data);

    let videoUrl: string | null = null;
    if (hasVideo) {
      await setupCache(projectId, videoPath);
      videoUrl = `/static/${projectId}/input.mp4`;
    }

    const state = buildProjectState(data, {
      videoUrl,
      projectFilePath,
    });

    // Generate thumbnail and add to registry
    const thumbnail = hasVideo ? generateThumbnail(videoPath) : null;
    await addToRegistry({
      projectId,
      projectPath: projectFilePath,
      videoName,
      state: data.state,
      updatedAt: now,
      thumbnail,
    });

    return state;
  }

  /**
   * Open an existing .lusk project file.
   * Reads the ZIP, checks if the source video still exists, and sets up cache if possible.
   */
  async openProject(projectFilePath: string): Promise<ProjectState> {
    const data = readLuskFile(projectFilePath);
    const videoExists = await fileExists(data.videoPath);

    let videoUrl: string | null = null;
    let stateOverride: PipelineState | undefined;

    if (videoExists) {
      await setupCache(data.projectId, data.videoPath);
      videoUrl = `/static/${data.projectId}/input.mp4`;
      // TRANSCRIBING can't survive a server restart — reset so it can be retried
      if (data.state === "TRANSCRIBING") stateOverride = "UPLOADING";
      const meta = probeVideoMeta(data.videoPath);
      data.videoWidth = data.videoWidth ?? meta.width;
      data.videoHeight = data.videoHeight ?? meta.height;
    } else {
      // Video is missing – fall back to IDLE so the UI can prompt re-link
      stateOverride = "IDLE";
    }

    const state = buildProjectState(data, {
      videoUrl,
      projectFilePath,
      stateOverride,
    });

    // Register / bump in recent list
    const thumbnail = videoExists
      ? generateThumbnail(data.videoPath)
      : null;

    await addToRegistry({
      projectId: data.projectId,
      projectPath: projectFilePath,
      videoName: data.videoName,
      state: state.state,
      updatedAt: data.updatedAt,
      thumbnail,
      missing: !videoExists,
    });

    return state;
  }

  /**
   * Save the current project state back to its .lusk file.
   * Extracts only the persisted ProjectData fields.
   */
  async saveProject(session: ProjectState): Promise<void> {
    if (!session.projectFilePath) {
      throw new Error("Cannot save project: no projectFilePath set");
    }

    const data: ProjectData = {
      version: session.version,
      projectId: session.projectId,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      videoPath: session.videoPath,
      videoName: session.videoName,
      videoDurationMs: session.videoDurationMs,
      videoWidth: session.videoWidth ?? null,
      videoHeight: session.videoHeight ?? null,
      state: session.state,
      transcript: session.transcript,
      originalTranscript: session.originalTranscript ?? null,
      correctedTranscriptRaw: session.correctedTranscriptRaw ?? null,
      scriptText: session.scriptText ?? null,
      captions: session.captions,
      viralClips: session.viralClips,
    };

    writeLuskFile(session.projectFilePath, data);

    // Update registry — also repair missing thumbnail if video is available
    const patch: Partial<Omit<RecentProject, "projectId" | "projectPath">> = {
      videoName: data.videoName,
      state: data.state,
      updatedAt: data.updatedAt,
    };

    {
      const entries = await readRegistry();
      const existing = entries.find((e) => e.projectPath === session.projectFilePath);
      if (existing && !existing.thumbnail) {
        // Try original video path first, then fall back to cached copy in temp dir
        const cachePath = join(tempManager.getSessionDir(session.projectId), "input.mp4");
        const videoPath = (data.videoPath && await fileExists(data.videoPath))
          ? data.videoPath
          : (await fileExists(cachePath) ? cachePath : null);
        if (videoPath) {
          patch.thumbnail = generateThumbnail(videoPath);
        }
      }
    }

    await updateRegistryEntry(session.projectFilePath, patch);
  }

  // -------------------------------------------------------------------------
  // Registry queries
  // -------------------------------------------------------------------------

  /** Return the list of recent projects, marking missing files, and repairing missing metadata where possible. */
  async getRecentProjects(): Promise<RecentProject[]> {
    const entries = await readRegistry();
    const validated: RecentProject[] = [];
    let needsSave = false;

    for (const entry of entries) {
      const exists = await fileExists(entry.projectPath);
      let updatedEntry = { ...entry, missing: !exists };
      
      if (exists && (!updatedEntry.videoName || !updatedEntry.thumbnail)) {
        try {
          const data = readLuskFile(entry.projectPath);
          updatedEntry.videoName = data.videoName || updatedEntry.videoName;
          updatedEntry.state = data.state || updatedEntry.state;
          updatedEntry.updatedAt = data.updatedAt || updatedEntry.updatedAt;
          
          if (!updatedEntry.thumbnail) {
             // Try original video path, then cached copy in temp dir
             const cachePath = join(tempManager.getSessionDir(data.projectId), "input.mp4");
             const videoPath = (data.videoPath && await fileExists(data.videoPath))
               ? data.videoPath
               : (await fileExists(cachePath) ? cachePath : null);
             if (videoPath) {
               updatedEntry.thumbnail = generateThumbnail(videoPath);
             }
          }
          needsSave = true;
        } catch {
          // Ignore read errors
        }
      }

      validated.push(updatedEntry);
    }

    if (needsSave && validated.length > 0) {
      await writeRegistry(validated);
    }
    
    return validated;
  }

  /** Set up the cache directory with a symlink to the source video. */
  async setupCache(projectId: string, videoPath: string): Promise<void> {
    await setupCache(projectId, videoPath);
  }

  /** Remove a single entry from the recent projects registry by project ID. */
  async removeFromRegistry(projectId: string): Promise<void> {
    let entries = await readRegistry();
    entries = entries.filter((e) => e.projectId !== projectId);
    await writeRegistry(entries);
  }
}

export const projectFileService = new ProjectFileService();
export { ProjectFileService };
