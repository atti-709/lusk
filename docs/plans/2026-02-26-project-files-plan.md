# Project Files Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace internal UUID sessions with user-facing `.lusk` project files, a server registry for recent projects, and a dashboard UI.

**Architecture:** The `.lusk` file is a ZIP containing `project.json` (metadata only, no video). The server manages all filesystem operations. A registry file tracks recently opened projects. The existing `.lusk_temp/` cache holds symlinked videos and rendered clips.

**Tech Stack:** Node.js/Fastify server, React/Vite client, AdmZip for ZIP I/O, Electron IPC for native dialogs, ffmpeg for thumbnails.

---

### Task 1: Add New Shared Types

**Files:**
- Modify: `shared/types.ts`

**Step 1: Add ProjectData interface and update types**

Add `ProjectData` (the persisted subset), `RecentProject` (for the registry), and `BrowseRequest`/`BrowseResponse` types. Update `ProjectState` to extend `ProjectData`. Replace `SessionSummary` with `RecentProject` for the dashboard.

```typescript
// Add after CaptionWord interface (line 74):

export interface ProjectData {
  version: number;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  videoPath: string;
  videoName: string;
  videoDurationMs: number | null;
  state: PipelineState;
  transcript: TranscriptData | null;
  correctedTranscriptRaw?: string | null;
  captions: CaptionWord[] | null;
  viralClips: ViralClip[] | null;
}

export interface RecentProject {
  projectId: string;
  projectPath: string;
  videoName: string;
  state: PipelineState;
  updatedAt: string;
  thumbnail: string | null; // base64 JPEG
  missing?: boolean;        // true if .lusk file not found on disk
}

export interface BrowseRequest {
  type: "save" | "open";
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}

export interface BrowseResponse {
  canceled: boolean;
  filePath: string | null;
}
```

**Step 2: Update ProjectState to extend ProjectData**

Replace the existing `ProjectState` interface (lines 83-98) with:

```typescript
export interface ProjectState extends ProjectData {
  // Derived at load time
  videoUrl: string | null;
  // Runtime-only (not persisted to .lusk)
  progress: number;
  message: string;
  renders: Record<string, ClipRenderState>;
  outputUrl: string | null;
  // Internal: path to the .lusk file on disk
  projectFilePath: string | null;
}
```

**Step 3: Remove SessionSummary, update ImportResponse → OpenProjectResponse**

Remove `SessionSummary` (lines 47-53). Replace `ImportResponse` (lines 111-115) with:

```typescript
export interface OpenProjectResponse {
  success: boolean;
  projectId: string;
  videoName: string | null;
}

export interface CreateProjectResponse {
  success: boolean;
  projectId: string;
}
```

Keep `UploadResponse` for now (will be removed in a later task when upload route is replaced).

**Step 4: Commit**

```
feat: add ProjectData, RecentProject types for project files
```

---

### Task 2: Create ProjectFileService

**Files:**
- Create: `server/src/services/ProjectFileService.ts`

**Step 1: Implement the service**

This service handles reading/writing `.lusk` ZIP files and managing the recent projects registry.

```typescript
import { randomUUID } from "node:crypto";
import { readFile, writeFile, access, mkdir, symlink, readlink, unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import AdmZip from "adm-zip";
import type { ProjectData, ProjectState, RecentProject, PipelineState } from "@lusk/shared";
import { tempManager } from "./TempManager.js";

const REGISTRY_MAX = 20;
const PROJECT_VERSION = 1;

class ProjectFileService {
  private registryPath: string;

  constructor() {
    const dir = process.env.LUSK_REGISTRY_DIR ?? join(homedir(), ".lusk");
    this.registryPath = join(dir, "recent-projects.json");
  }

  /** Create a new .lusk project file at the given path */
  async createProject(projectPath: string, videoPath: string): Promise<ProjectState> {
    const projectId = randomUUID();
    const now = new Date().toISOString();

    // Probe video duration via ffprobe
    let videoDurationMs: number | null = null;
    try {
      const out = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
        { stdio: ["ignore", "pipe", "ignore"] }
      ).toString().trim();
      videoDurationMs = Math.round(parseFloat(out) * 1000);
    } catch { /* non-fatal */ }

    // Sanitize video name from filename
    const videoName = videoPath
      .split("/").pop()!
      .replace(/\.[^.]+$/, "")
      .replace(/_/g, " ");

    const data: ProjectData = {
      version: PROJECT_VERSION,
      projectId,
      createdAt: now,
      updatedAt: now,
      videoPath,
      videoName,
      videoDurationMs,
      state: "UPLOADING",
      transcript: null,
      correctedTranscriptRaw: null,
      captions: null,
      viralClips: null,
    };

    // Write .lusk file
    await this.writeProjectFile(projectPath, data);

    // Set up cache (symlink video)
    await this.setupCache(projectId, videoPath);

    // Build runtime state
    const state: ProjectState = {
      ...data,
      videoUrl: `/static/${projectId}/input.mp4`,
      progress: 100,
      message: "Upload complete",
      renders: {},
      outputUrl: null,
      projectFilePath: projectPath,
    };

    // Update registry
    await this.addToRegistry(state, projectPath);

    return state;
  }

  /** Open an existing .lusk file */
  async openProject(projectPath: string): Promise<ProjectState> {
    const data = await this.readProjectFile(projectPath);

    // Set up cache (symlink video)
    const videoExists = await this.fileExists(data.videoPath);
    if (videoExists) {
      await this.setupCache(data.projectId, data.videoPath);
    }

    const state: ProjectState = {
      ...data,
      videoUrl: videoExists ? `/static/${data.projectId}/input.mp4` : null,
      progress: 0,
      message: "",
      renders: {},
      outputUrl: null,
      projectFilePath: projectPath,
    };

    // If video is missing, set state to IDLE so user can re-link
    if (!videoExists && data.state !== "IDLE") {
      state.state = "IDLE";
    }

    // Update registry
    await this.addToRegistry(state, projectPath);

    return state;
  }

  /** Save project state to the .lusk file */
  async saveProject(state: ProjectState): Promise<void> {
    if (!state.projectFilePath) return;

    const data: ProjectData = {
      version: PROJECT_VERSION,
      projectId: state.projectId ?? state.sessionId,
      createdAt: state.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      videoPath: state.videoPath ?? "",
      videoName: state.videoName ?? "",
      videoDurationMs: state.videoDurationMs,
      state: state.state,
      transcript: state.transcript,
      correctedTranscriptRaw: state.correctedTranscriptRaw ?? null,
      captions: state.captions,
      viralClips: state.viralClips,
    };

    await this.writeProjectFile(state.projectFilePath, data);

    // Update registry
    await this.updateRegistryEntry(data.projectId, {
      state: data.state,
      updatedAt: data.updatedAt,
      videoName: data.videoName,
    });
  }

  /** Set up cache directory with symlink to video */
  async setupCache(projectId: string, videoPath: string): Promise<void> {
    const cacheDir = await tempManager.ensureSessionDir(projectId);
    const linkPath = join(cacheDir, "input.mp4");

    // Remove existing symlink if it points somewhere else
    try {
      const existing = await readlink(linkPath);
      if (existing === videoPath) return; // already correct
      await unlink(linkPath);
    } catch {
      // No existing link
    }

    try {
      await symlink(videoPath, linkPath);
    } catch {
      // Cross-volume: fall back to copy (but warn)
      const { copyFile } = await import("node:fs/promises");
      await copyFile(videoPath, linkPath);
    }
  }

  /** Read and parse a .lusk ZIP file */
  async readProjectFile(projectPath: string): Promise<ProjectData> {
    const buffer = await readFile(projectPath);
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("project.json");
    if (!entry) throw new Error("Invalid .lusk file: missing project.json");
    return JSON.parse(entry.getData().toString("utf-8")) as ProjectData;
  }

  /** Write project data to a .lusk ZIP file */
  async writeProjectFile(projectPath: string, data: ProjectData): Promise<void> {
    // Ensure parent directory exists
    await mkdir(dirname(projectPath), { recursive: true });

    const zip = new AdmZip();
    zip.addFile("project.json", Buffer.from(JSON.stringify(data, null, 2)));
    zip.writeZip(projectPath);
  }

  /** Generate a thumbnail from the video */
  async generateThumbnail(videoPath: string): Promise<string | null> {
    try {
      const buf = execSync(
        `ffmpeg -i "${videoPath}" -vframes 1 -vf "scale=180:-1" -f image2 -c:v mjpeg pipe:1`,
        { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 }
      );
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }

  // ── Registry ──────────────────────────────────────────────────────────

  async getRecentProjects(): Promise<RecentProject[]> {
    const registry = await this.readRegistry();

    // Validate each entry still exists
    const validated = await Promise.all(
      registry.map(async (entry) => {
        const exists = await this.fileExists(entry.projectPath);
        return { ...entry, missing: !exists };
      })
    );

    return validated;
  }

  async removeFromRegistry(projectId: string): Promise<void> {
    const registry = await this.readRegistry();
    const filtered = registry.filter((r) => r.projectId !== projectId);
    await this.writeRegistry(filtered);
  }

  private async addToRegistry(state: ProjectState, projectPath: string): Promise<void> {
    const registry = await this.readRegistry();

    // Remove existing entry for this project
    const filtered = registry.filter((r) => r.projectId !== (state.projectId ?? state.sessionId));

    // Generate thumbnail if video exists
    let thumbnail: string | null = null;
    if (state.videoPath) {
      thumbnail = await this.generateThumbnail(state.videoPath);
    }

    const entry: RecentProject = {
      projectId: state.projectId ?? state.sessionId,
      projectPath,
      videoName: state.videoName ?? "",
      state: state.state,
      updatedAt: new Date().toISOString(),
      thumbnail,
    };

    // Prepend (most recent first), cap at max
    filtered.unshift(entry);
    await this.writeRegistry(filtered.slice(0, REGISTRY_MAX));
  }

  private async updateRegistryEntry(
    projectId: string,
    updates: Partial<Pick<RecentProject, "state" | "updatedAt" | "videoName">>
  ): Promise<void> {
    const registry = await this.readRegistry();
    const entry = registry.find((r) => r.projectId === projectId);
    if (entry) {
      Object.assign(entry, updates);
      await this.writeRegistry(registry);
    }
  }

  private async readRegistry(): Promise<RecentProject[]> {
    try {
      const raw = await readFile(this.registryPath, "utf-8");
      const data = JSON.parse(raw);
      return data.recentProjects ?? [];
    } catch {
      return [];
    }
  }

  private async writeRegistry(entries: RecentProject[]): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    await writeFile(
      this.registryPath,
      JSON.stringify({ recentProjects: entries }, null, 2)
    );
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export const projectFileService = new ProjectFileService();
```

**Step 2: Commit**

```
feat: add ProjectFileService for .lusk file and registry management
```

---

### Task 3: Update Orchestrator for Project File Persistence

**Files:**
- Modify: `server/src/services/Orchestrator.ts`

**Step 1: Replace persistSession with project-file-aware persistence**

The orchestrator needs to:
1. Track `projectFilePath` per session
2. Use debounced writes to the `.lusk` file instead of `session.json`
3. Support immediate saves for major transitions

Replace the `persistSession` method (lines 153-172) and add debouncing:

```typescript
// Add at top of file:
import { projectFileService } from "./ProjectFileService.js";

// Add to class fields (after line 27):
private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
private readonly SAVE_DEBOUNCE_MS = 2000;

// New method: immediate save
async saveProjectNow(id: string): Promise<void> {
  // Cancel any pending debounced save
  const timer = this.saveTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    this.saveTimers.delete(id);
  }

  const session = this.sessions.get(id);
  if (!session?.projectFilePath) return;

  const prev = this.writeQueue.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    await projectFileService.saveProject(session);
  }).catch(() => {});
  this.writeQueue.set(id, next);
}

// Replace persistSession:
private persistSession(id: string): void {
  const session = this.sessions.get(id);
  if (!session?.projectFilePath) return;

  // Debounced save
  const existing = this.saveTimers.get(id);
  if (existing) clearTimeout(existing);

  this.saveTimers.set(id, setTimeout(() => {
    this.saveTimers.delete(id);
    this.saveProjectNow(id).catch(() => {});
  }, this.SAVE_DEBOUNCE_MS));
}
```

Update `transition()` (line 60) to do immediate saves on major state changes:

```typescript
transition(id: string, newState: PipelineState): void {
  const session = this.requireSession(id);
  const allowed = TRANSITIONS[session.state];
  if (!allowed.includes(newState)) {
    throw new Error(`Invalid transition: ${session.state} → ${newState}`);
  }
  session.state = newState;
  session.progress = 0;
  session.message = "";
  this.emitProgress(session);
  // Immediate save on state transitions
  this.saveProjectNow(id).catch(() => {});
}
```

Update `createSession` to accept and store `projectFilePath`:

```typescript
createSession(id: string, videoUrl: string, videoName: string | null = null, videoDurationMs: number | null = null, projectFilePath: string | null = null): ProjectState {
  const state: ProjectState = {
    version: 1,
    projectId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    videoPath: "",
    sessionId: id, // keep for backwards compat during migration
    state: "UPLOADING",
    progress: 100,
    message: "Upload complete",
    videoUrl,
    videoName,
    videoDurationMs,
    transcript: null,
    correctedTranscriptRaw: null,
    captions: null,
    viralClips: null,
    outputUrl: null,
    renders: {},
    projectFilePath,
  };
  this.sessions.set(id, state);
  this.emitProgress(state);
  this.persistSession(id);
  return state;
}
```

**Step 2: Commit**

```
feat: update Orchestrator with debounced .lusk file persistence
```

---

### Task 4: Create Server Routes for Project Operations

**Files:**
- Create: `server/src/routes/projects.ts`

**Step 1: Implement project routes**

```typescript
import { FastifyInstance } from "fastify";
import type { BrowseRequest, BrowseResponse, RecentProject, ErrorResponse, CreateProjectResponse, OpenProjectResponse } from "@lusk/shared";
import { orchestrator } from "../services/Orchestrator.js";
import { projectFileService } from "../services/ProjectFileService.js";

export async function projectsRoute(app: FastifyInstance) {

  // ── Browse (server-side file dialog) ──────────────────────────────────
  app.post<{ Body: BrowseRequest; Reply: BrowseResponse }>(
    "/api/browse",
    async (request) => {
      const { type, title, filters, defaultPath } = request.body;

      // Send IPC to Electron if available, otherwise return a "not supported" response
      const electron = (globalThis as any).__luskElectronIPC;
      if (!electron) {
        // In browser-only mode, we can't show native dialogs
        return { canceled: true, filePath: null };
      }

      const result = await electron.showDialog({ type, title, filters, defaultPath });
      return result;
    }
  );

  // ── Create project ──────────────────────────────────────────────────
  app.post<{
    Body: { projectPath: string; videoPath: string };
    Reply: CreateProjectResponse | ErrorResponse;
  }>(
    "/api/projects/create",
    async (request, reply) => {
      const { projectPath, videoPath } = request.body;

      try {
        const state = await projectFileService.createProject(projectPath, videoPath);
        orchestrator.restoreSession(state);
        return { success: true, projectId: state.projectId };
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  );

  // ── Open project ──────────────────────────────────────────────────
  app.post<{
    Body: { projectPath: string };
    Reply: OpenProjectResponse | ErrorResponse;
  }>(
    "/api/projects/open",
    async (request, reply) => {
      const { projectPath } = request.body;

      try {
        const state = await projectFileService.openProject(projectPath);
        orchestrator.restoreSession(state);
        return {
          success: true,
          projectId: state.projectId,
          videoName: state.videoName,
        };
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  );

  // ── Recent projects ──────────────────────────────────────────────────
  app.get<{ Reply: RecentProject[] }>(
    "/api/projects/recent",
    async () => {
      return projectFileService.getRecentProjects();
    }
  );

  // ── Remove from recent ──────────────────────────────────────────────
  app.delete<{ Params: { projectId: string } }>(
    "/api/projects/recent/:projectId",
    async (request) => {
      await projectFileService.removeFromRegistry(request.params.projectId);
      return { success: true };
    }
  );

  // ── Select video for a project ──────────────────────────────────────
  app.post<{
    Params: { projectId: string };
    Body: { videoPath: string };
    Reply: { success: boolean } | ErrorResponse;
  }>(
    "/api/projects/:projectId/select-video",
    async (request, reply) => {
      const { projectId } = request.params;
      const { videoPath } = request.body;

      const session = orchestrator.getSession(projectId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Project not found" });
      }

      // Set up cache with symlink
      await projectFileService.setupCache(projectId, videoPath);

      // Update session state
      session.videoPath = videoPath;
      session.videoUrl = `/static/${projectId}/input.mp4`;

      // Probe duration
      try {
        const { execSync } = await import("node:child_process");
        const out = execSync(
          `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
          { stdio: ["ignore", "pipe", "ignore"] }
        ).toString().trim();
        session.videoDurationMs = Math.round(parseFloat(out) * 1000);
      } catch { /* non-fatal */ }

      // Transition to UPLOADING so transcription can begin
      session.state = "UPLOADING";
      session.progress = 100;
      session.message = "Video selected";
      orchestrator.emitAndPersist(projectId);

      return { success: true };
    }
  );
}
```

**Step 2: Register the route in index.ts**

In `server/src/index.ts`, add:
```typescript
import { projectsRoute } from "./routes/projects.js";
```
And register it:
```typescript
await server.register(projectsRoute);
```

**Step 3: Commit**

```
feat: add server routes for project create/open/browse/recent
```

---

### Task 5: Update Server Startup (Remove Session Scan)

**Files:**
- Modify: `server/src/index.ts` (lines 49-82)

**Step 1: Remove the session restore loop**

Replace lines 49-82 (the session scanning and restore logic) with a comment:

```typescript
// Projects are loaded on-demand when opened from the dashboard.
// No startup session scanning needed.
```

**Step 2: Commit**

```
refactor: remove startup session scanning, projects load on-demand
```

---

### Task 6: Re-path Existing Routes from session to project

**Files:**
- Modify: `server/src/routes/project.ts` — change `/api/project/:sessionId` to `/api/projects/:projectId`
- Modify: `server/src/routes/align.ts` — change all `/api/project/:sessionId/...` to `/api/projects/:projectId/...`
- Modify: `server/src/routes/events.ts` — change `/api/events/:sessionId` to `/api/events/:projectId`
- Modify: `server/src/routes/render.ts` — keep `/api/render` as-is (uses body `sessionId`)
- Modify: `server/src/routes/transcribe.ts` — keep `/api/transcribe` as-is (uses body `sessionId`)

**Step 1: Update route paths**

In each file, do a find-replace of `:sessionId` param to `:projectId` in the URL patterns, and update the destructuring from `request.params`. The underlying `orchestrator.getSession()` still uses the same ID.

Also add backwards-compatible aliases if needed (e.g., keep old paths redirecting temporarily).

**Step 2: Commit**

```
refactor: re-path session routes to /api/projects/:projectId
```

---

### Task 7: Remove Old Session/Export/Import Routes

**Files:**
- Modify: `server/src/routes/sessions.ts` — remove `GET /api/sessions` and `DELETE /api/sessions/:id` (replaced by `/api/projects/recent`)
- Modify: `server/src/routes/exportImport.ts` — remove export and import endpoints (project IS the file now). Keep rendered-clips listing and sync-render-states but re-path them.
- Modify: `server/src/routes/upload.ts` — remove `POST /api/upload` (replaced by `/api/projects/create` + `/select-video`). Keep `POST /api/sessions/:sessionId/upload-video` temporarily for the IDLE-state re-link flow (can be re-pathed later).
- Modify: `server/src/index.ts` — remove registrations of deleted routes

**Step 1: Gut the old routes**

Remove the route handlers that are now replaced. For `exportImport.ts`, keep the rendered-clips endpoint and `sync-render-states`, but remove the export ZIP streaming and the multipart import.

**Step 2: Commit**

```
refactor: remove old session/export/import routes, replaced by project API
```

---

### Task 8: Update Electron Main Process

**Files:**
- Modify: `electron/src/main.ts`

**Step 1: Add IPC handlers for native dialogs**

Add `ipcMain.handle` registrations after `createWindow()` call:

```typescript
import { ipcMain } from "electron";

// Register IPC handlers for file dialogs
ipcMain.handle("show-save-dialog", async (_event, options) => {
  if (!mainWindow) return { canceled: true, filePath: null };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title ?? "Save",
    defaultPath: options.defaultPath,
    filters: options.filters ?? [{ name: "Lusk Project", extensions: ["lusk"] }],
  });
  return { canceled: result.canceled, filePath: result.filePath ?? null };
});

ipcMain.handle("show-open-dialog", async (_event, options) => {
  if (!mainWindow) return { canceled: true, filePath: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title ?? "Open",
    defaultPath: options.defaultPath,
    filters: options.filters ?? [{ name: "Lusk Project", extensions: ["lusk"] }],
    properties: ["openFile"],
  });
  return {
    canceled: result.canceled,
    filePath: result.filePaths?.[0] ?? null,
  };
});
```

**Step 2: Update `open-file` handler to use new API**

Replace `importLuskFile` (lines 25-45) with:

```typescript
async function openLuskFile(filePath: string): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: filePath }),
    });

    if (res.ok) {
      const data = (await res.json()) as { projectId: string };
      mainWindow?.webContents.send("open-session", data.projectId);
    }
  } catch (err) {
    console.error("Failed to open .lusk file:", err);
  }
}
```

Update all references from `importLuskFile` to `openLuskFile`.

**Step 3: Pass registry dir env var to server**

In `startServer()` (around line 156), add:
```typescript
LUSK_REGISTRY_DIR: path.join(app.getPath("userData")),
```

**Step 4: Commit**

```
feat: add Electron IPC handlers for native file dialogs
```

---

### Task 9: Update Electron Preload

**Files:**
- Modify: `electron/src/preload.ts`

**Step 1: Expose new IPC channels**

Replace the current preload (all 8 lines) with:

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lusk", {
  isElectron: true,

  onOpenSession: (callback: (sessionId: string) => void) => {
    ipcRenderer.on("open-session", (_event, sessionId: string) => callback(sessionId));
  },

  showSaveDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => ipcRenderer.invoke("show-save-dialog", options ?? {}),

  showOpenDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => ipcRenderer.invoke("show-open-dialog", options ?? {}),
});
```

**Step 2: Add TypeScript declarations for window.lusk**

Create `client/src/lusk.d.ts`:

```typescript
interface LuskBridge {
  isElectron: true;
  onOpenSession: (callback: (sessionId: string) => void) => void;
  showSaveDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ canceled: boolean; filePath: string | null }>;
  showOpenDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ canceled: boolean; filePath: string | null }>;
}

declare global {
  interface Window {
    lusk?: LuskBridge;
  }
}

export {};
```

**Step 3: Commit**

```
feat: expose native dialog IPC in Electron preload
```

---

### Task 10: Create Dashboard Component

**Files:**
- Create: `client/src/components/Dashboard.tsx`
- Modify: `client/src/components/ResumeDialog.tsx` (will be replaced by Dashboard)

**Step 1: Create Dashboard component**

The Dashboard replaces `ResumeDialog` and `UploadZone` for the initial view. It shows recent projects, and has "New Project" + "Open Project" buttons.

```typescript
import { useState, useEffect } from "react";
import type { RecentProject } from "@lusk/shared";

const STATE_LABELS: Record<string, string> = {
  IDLE: "No Video",
  UPLOADING: "Uploaded",
  TRANSCRIBING: "Transcribing",
  ALIGNING: "Aligning",
  READY: "Ready",
  RENDERING: "Rendering",
  EXPORTED: "Exported",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

interface DashboardProps {
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
  onOpenFile: () => void;
}

export function Dashboard({ onOpenProject, onNewProject, onOpenFile }: DashboardProps) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects/recent")
      .then((r) => r.json())
      .then((data: RecentProject[]) => {
        setProjects(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleRemove = async (projectId: string) => {
    await fetch(`/api/projects/recent/${projectId}`, { method: "DELETE" });
    setProjects((prev) => prev.filter((p) => p.projectId !== projectId));
  };

  if (loading) return <div className="connecting">Loading</div>;

  return (
    <div className="dashboard">
      <div className="dashboard-actions">
        <button className="primary" onClick={onNewProject}>
          + New Project
        </button>
        <button className="secondary" onClick={onOpenFile}>
          Open Project...
        </button>
      </div>

      {projects.length === 0 && (
        <div className="dashboard-empty">
          <p>No recent projects</p>
          <p className="dashboard-hint">Create a new project or open an existing .lusk file</p>
        </div>
      )}

      {projects.length > 0 && (
        <>
          <h2 className="dashboard-section-title">Recent Projects</h2>
          <div className="project-grid">
            {projects.map((p) => (
              <div
                key={p.projectId}
                className={`project-card ${p.missing ? "project-card--missing" : ""}`}
                onClick={() => !p.missing && onOpenProject(p.projectId)}
                role="button"
                tabIndex={0}
              >
                <div className="project-card__thumb">
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" />
                  ) : (
                    <div className="project-card__thumb-placeholder" />
                  )}
                </div>
                <div className="project-card__info">
                  <span className="project-card__name">{p.videoName}</span>
                  <span className="project-card__meta">
                    <span className={`state-badge state-badge--${p.state.toLowerCase()}`}>
                      {STATE_LABELS[p.state] ?? p.state}
                    </span>
                    <span className="project-card__time">{formatTime(p.updatedAt)}</span>
                  </span>
                </div>
                {p.missing && (
                  <div className="project-card__missing">
                    <span>File not found</span>
                    <button
                      className="project-card__remove"
                      onClick={(e) => { e.stopPropagation(); handleRemove(p.projectId); }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

**Step 2: Add Dashboard CSS**

Add styles to `client/src/App.css` for `.dashboard`, `.project-grid`, `.project-card`, etc. Use the same visual language as the existing `ResumeDialog` cards but with thumbnails.

**Step 3: Commit**

```
feat: create Dashboard component with recent projects grid
```

---

### Task 11: Update App.tsx for Project-Based Flow

**Files:**
- Modify: `client/src/App.tsx`

**Step 1: Replace view states**

Change the `AppView` type (line 25) from `"loading" | "resume" | "upload" | "session"` to `"loading" | "dashboard" | "session"`.

**Step 2: Replace session fetching with project-based flow**

Replace the mount effect (lines 44-58) with:

```typescript
useEffect(() => {
  // Go straight to dashboard
  setView("dashboard");
}, []);
```

**Step 3: Add new project and open project handlers**

Replace `handleNew`, `handleImport`, `handleUploadComplete`, `handleResume`, `handleDeleteSession` with:

```typescript
const handleNewProject = useCallback(async () => {
  const lusk = window.lusk;
  if (!lusk) return;

  // 1. Pick save location
  const saveResult = await lusk.showSaveDialog({
    title: "Save new project as...",
    filters: [{ name: "Lusk Project", extensions: ["lusk"] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return;

  // 2. Pick video file
  const videoResult = await lusk.showOpenDialog({
    title: "Select video file",
    filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm"] }],
  });
  if (videoResult.canceled || !videoResult.filePath) return;

  // 3. Create project via server
  const res = await fetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: saveResult.filePath,
      videoPath: videoResult.filePath,
    }),
  });

  if (res.ok) {
    const data = await res.json();
    resetSessionState();
    setSessionId(data.projectId);
    setView("session");

    // Start transcription
    fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: data.projectId }),
    }).catch(() => {});
  }
}, []);

const handleOpenFile = useCallback(async () => {
  const lusk = window.lusk;
  if (!lusk) return;

  const result = await lusk.showOpenDialog({
    title: "Open project",
    filters: [{ name: "Lusk Project", extensions: ["lusk"] }],
  });
  if (result.canceled || !result.filePath) return;

  const res = await fetch("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath: result.filePath }),
  });

  if (res.ok) {
    const data = await res.json();
    resetSessionState();
    setSessionId(data.projectId);
    setView("session");
  }
}, []);

const handleOpenProject = useCallback(async (projectId: string) => {
  // Project is already in the registry, just open it
  const res = await fetch(`/api/project/${projectId}`);
  if (res.ok) {
    resetSessionState();
    setSessionId(projectId);
    setView("session");
  }
}, []);

const resetSessionState = useCallback(() => {
  setCaptions([]);
  setViralClips([]);
  setSelectedClip(null);
  setReadySubView("review");
}, []);
```

**Step 4: Update handleLogoClick**

Replace `handleLogoClick` (lines 288-309) to simply go to dashboard:

```typescript
const handleLogoClick = useCallback(() => {
  if (view === "dashboard" || view === "loading") return;
  setView("dashboard");
}, [view]);
```

**Step 5: Update JSX**

Replace `view === "resume"` block with `view === "dashboard"`:

```tsx
{view === "dashboard" && (
  <Dashboard
    onOpenProject={handleOpenProject}
    onNewProject={handleNewProject}
    onOpenFile={handleOpenFile}
  />
)}
```

Remove the `view === "upload"` block entirely (no more standalone upload view).

**Step 6: Update imports**

Add `Dashboard` import, remove `ResumeDialog` and `UploadZone` imports (UploadZone may still be needed if you keep a fallback for browser mode — decide based on whether browser mode is still supported).

**Step 7: Commit**

```
feat: update App.tsx for project-file-based flow with Dashboard
```

---

### Task 12: Update Client API Calls

**Files:**
- Modify: `client/src/components/ClipSelector.tsx` — update `/api/project/${sessionId}/export` to remove export functionality (project is the file). Update rendered-clips endpoint path.
- Modify: `client/src/components/AlignStep.tsx` — update route paths from `/api/project/` to `/api/projects/`
- Modify: `client/src/hooks/useSSE.ts` — update SSE URL if it changed

**Step 1: Update API endpoint paths**

In each file, update the URL patterns from `/api/project/:sessionId/...` to `/api/projects/:projectId/...` and from `/api/sessions/:sessionId/...` to `/api/projects/:projectId/...`.

**Step 2: Remove export button from ClipSelector**

The "Export project" button in `ClipSelector.tsx` is no longer needed since the project IS the file. Remove the `streamExport` function and its UI.

**Step 3: Commit**

```
refactor: update client API calls to new /api/projects/ paths
```

---

### Task 13: Clean Up Unused Code

**Files:**
- Delete or gut: `client/src/components/ResumeDialog.tsx` (replaced by Dashboard)
- Delete or gut: `client/src/components/UploadZone.tsx` (if browser mode is dropped)
- Remove: unused imports in `server/src/index.ts`
- Remove: `server/src/routes/sessions.ts` (if fully replaced)

**Step 1: Remove dead code**

Delete files that are no longer imported. Remove unused imports from remaining files.

**Step 2: Commit**

```
chore: remove unused session-based components and routes
```

---

### Task 14: End-to-End Testing

**Step 1: Manual test new project flow**

1. Run `npm run dev`
2. Open in browser / Electron
3. Click "New Project" → verify save dialog appears
4. Pick save location and video → verify project creates, transcription starts
5. Complete transcription → verify `.lusk` file is updated
6. Add clips → verify `.lusk` file is updated
7. Close and reopen → verify dashboard shows the project
8. Click project → verify it opens correctly with all data

**Step 2: Test open-file from Finder (Electron)**

1. Double-click a `.lusk` file in Finder
2. Verify it opens in the Electron app

**Step 3: Test missing video**

1. Move the source video to a different location
2. Open the `.lusk` project
3. Verify "missing video" state appears
4. Select new video via browse → verify it re-links

**Step 4: Test registry**

1. Create multiple projects
2. Verify dashboard shows them in order (most recent first)
3. Delete a `.lusk` file from disk
4. Verify dashboard shows it greyed out with "Remove" button

**Step 5: Commit if any fixes needed**

```
fix: address issues found during e2e testing
```

---

## Task Dependency Graph

```
Task 1 (types) ─┬─> Task 2 (ProjectFileService) ─┬─> Task 3 (Orchestrator)
                 │                                  │
                 │                                  ├─> Task 4 (routes) ──> Task 5 (startup)
                 │                                  │
                 │                                  └─> Task 6 (re-path) ──> Task 7 (cleanup old routes)
                 │
                 ├─> Task 8 (Electron main) ──> Task 9 (Electron preload)
                 │
                 └─> Task 10 (Dashboard) ──> Task 11 (App.tsx) ──> Task 12 (client API calls)
                                                                          │
                                                                          v
                                                                   Task 13 (cleanup) ──> Task 14 (testing)
```

Tasks 2, 8, and 10 can be worked on in parallel since they're independent (server service, Electron, and client component respectively).
