# Project Files Design

Replace internal UUID sessions with user-facing `.lusk` project files. Projects are lightweight ZIP archives containing only metadata (no video). A server-side registry tracks recently opened projects for the dashboard.

## Project File Format

The `.lusk` file is a ZIP (store mode, no compression) containing a single `project.json`:

```json
{
  "version": 1,
  "projectId": "uuid",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "videoPath": "/Users/atti/Videos/podcast-ep42.mp4",
  "videoName": "podcast ep42",
  "videoDurationMs": 3600000,
  "state": "READY",
  "transcript": { "..." : "..." },
  "correctedTranscriptRaw": "...",
  "captions": ["..."],
  "viralClips": ["..."]
}
```

- `videoPath`: absolute filesystem path to the original video (no copy/bundle).
- No `renders`, `outputUrl`, `progress`, or `message` — those are runtime-only.
- `version` field for future migration support.
- The server derives `videoUrl` at load time by symlinking the video into the cache.

## Server Registry & Recent Projects

A JSON file stores recently opened projects:

- **Path:** `~/.lusk/recent-projects.json` (Electron: `app.getPath('userData')/recent-projects.json`)

```json
{
  "recentProjects": [
    {
      "projectId": "uuid",
      "projectPath": "/Users/atti/Projects/podcast-ep42.lusk",
      "videoName": "podcast ep42",
      "state": "READY",
      "updatedAt": "ISO8601",
      "thumbnail": "base64-jpeg-small"
    }
  ]
}
```

- **Thumbnail:** Small JPEG (~320x568, 10-20KB) extracted via ffmpeg on first open, stored as base64.
- **Validation:** On listing, check each `projectPath` exists. Missing entries shown greyed out (not removed — drive may be unmounted).
- **Max entries:** 20, LRU eviction.
- **Updates:** Registry entry updated on every project save.

## Server API Changes

### New Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/projects/create` | POST | Create new `.lusk` file at given path, return projectId |
| `POST /api/projects/open` | POST | Open existing `.lusk` file, load into memory |
| `POST /api/projects/save` | POST | Save current state back to `.lusk` file |
| `GET /api/projects/recent` | GET | List recent projects from registry |
| `DELETE /api/projects/recent/:id` | DELETE | Remove from recent list |
| `POST /api/projects/:id/select-video` | POST | Associate video file path with project |
| `POST /api/browse` | POST | Server-side file/directory browse dialog |
| `POST /api/projects/:id/export-clip` | POST | Render + prompt for save location |

### Removed/Replaced

| Current | Replaced by |
|---|---|
| `POST /api/upload` | `POST /api/projects/create` + `/select-video` |
| `GET /api/sessions` | `GET /api/projects/recent` |
| `DELETE /api/sessions/:id` | `DELETE /api/projects/recent/:id` |
| `GET /api/project/:id/export` | No longer needed (project IS the file) |
| `POST /api/import` | `POST /api/projects/open` |

### Kept (re-pathed to `/api/projects/:id/...`)

All transcript, caption, clip, render, and SSE sub-routes stay functionally the same.

### Browse Endpoint

`POST /api/browse` with `{ type: "save" | "open", filters: [...] }`. In Electron, uses `dialog.showOpenDialog`/`dialog.showSaveDialog` via IPC. In browser mode, returns a simple path input.

## Frontend Flow & Dashboard

### View States

```
"loading" | "dashboard" | "session"
```

Replaces the current `"loading" | "resume" | "upload" | "session"`.

### Dashboard

- Grid of recent project cards: thumbnail, video name, state badge, last modified date.
- "New Project" button: browse for save location, then browse for video, create project, open.
- "Open Project" button: browse for `.lusk` file, open.
- Click card: open that project.
- Greyed-out cards for missing files with "Remove" option.
- Logo click returns to dashboard.

### New Project Flow

1. User clicks "New Project"
2. Server browse dialog: "Save project as..." -> user picks path
3. Server browse dialog: "Select video file..." -> user picks `.mp4`
4. Server creates `.lusk` ZIP, registers in recent projects, symlinks video to cache
5. Frontend navigates to session view, transcription begins

## Cache & Video Linking

Cache directory (`.lusk_temp/`) stays structurally the same, keyed by `projectId`:

```
.lusk_temp/
  {projectId}/
    input.mp4          <- symlink to original video path
    audio.wav          <- extracted during transcription
    output_*.mp4       <- rendered clips (disposable)
```

### On Project Open

1. Read `videoPath` from `project.json`
2. Check if path exists on disk
3. If yes: create cache dir, symlink `input.mp4 -> videoPath`
4. If no: open in "missing video" state, user can re-link via browse
5. Static serving unchanged (`/static/{projectId}/input.mp4`)

### On Project Save

Only the `.lusk` ZIP is written. Cache is never saved — it's all re-derivable.

### Cache Cleanup

Prune cache dirs not accessed in 30 days on startup. Symlink by default; fall back to copy if cross-volume.

## Orchestrator & Persistence Changes

### Persistence Split

- **Runtime state** (progress, message, renders): in memory only
- **Project state** (transcript, captions, clips, videoPath, state): auto-saved to `.lusk`

### Auto-Save Strategy

Debounced writes (2s) to avoid thrashing. Immediate save on major transitions (transcription complete, clip added/removed, state change).

### Startup

Server starts with no projects loaded. Projects load on-demand when opened from dashboard. Registry is read for listing only.

### Type Split

```typescript
// Persisted in .lusk file
interface ProjectData {
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

// Full runtime state (extends with ephemeral fields)
interface ProjectState extends ProjectData {
  videoUrl: string | null;       // derived at load time
  progress: number;              // runtime only
  message: string;               // runtime only
  renders: Record<string, ClipRenderState>; // runtime only
  outputUrl: string | null;      // runtime only
}
```
