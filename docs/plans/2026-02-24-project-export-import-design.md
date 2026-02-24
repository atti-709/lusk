# Project Export/Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow exporting a Lusk session as a `.lusk` file (zip archive) and importing `.lusk` files to restore projects.

**Architecture:** Server-side export endpoint streams a zip via `archiver` (already a dependency). Server-side import endpoint accepts multipart `.lusk` upload, extracts with Node's `node:zlib`/`tar` or `unzipper`. Client uses File System Access API with fallback to standard download for export, and file picker / drag-drop for import.

**Tech Stack:** Fastify routes, `archiver` for zip creation, `adm-zip` for extraction, React client components.

---

### Task 1: Add `adm-zip` dependency for import extraction

**Files:**
- Modify: `server/package.json`

**Step 1: Install adm-zip**

Run: `cd server && npm install adm-zip && npm install -D @types/adm-zip`

**Step 2: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore: add adm-zip for .lusk import extraction"
```

---

### Task 2: Add shared types for export/import

**Files:**
- Modify: `shared/types.ts`

**Step 1: Add ImportResponse type**

Add to `shared/types.ts`:

```typescript
export interface ImportResponse {
  success: boolean;
  sessionId: string;
  videoName: string | null;
}
```

**Step 2: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add ImportResponse shared type"
```

---

### Task 3: Server export route

**Files:**
- Create: `server/src/routes/exportImport.ts`
- Modify: `server/src/index.ts`

**Step 1: Create the export route**

Create `server/src/routes/exportImport.ts`:

```typescript
import { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import archiver from "archiver";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";

export async function exportImportRoute(app: FastifyInstance) {
  // Export: GET /api/project/:sessionId/export?includeVideo=true|false
  app.get<{ Params: { sessionId: string }; Querystring: { includeVideo?: string } }>(
    "/api/project/:sessionId/export",
    async (request, reply) => {
      const { sessionId } = request.params;
      const includeVideo = request.query.includeVideo === "true";

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const sessionDir = tempManager.getSessionDir(sessionId);
      const videoName = session.videoName ?? "project";
      const fileName = `${videoName}.lusk`;

      reply.raw.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      });

      const archive = archiver("zip", { zlib: { level: 1 } }); // Fast compression (video is already compressed)
      archive.pipe(reply.raw);

      // Add session JSON files
      const sessionJsonPath = join(sessionDir, "session.json");
      const metaJsonPath = join(sessionDir, "session-meta.json");
      archive.file(sessionJsonPath, { name: "session.json" });
      try {
        await access(metaJsonPath);
        archive.file(metaJsonPath, { name: "session-meta.json" });
      } catch {
        // meta file might not exist, skip
      }

      // Optionally add the source video
      if (includeVideo) {
        const videoPath = join(sessionDir, "input.mp4");
        try {
          await access(videoPath);
          archive.file(videoPath, { name: "input.mp4" });
        } catch {
          // Video might not exist
        }
      }

      await archive.finalize();
      return reply;
    }
  );
}
```

**Step 2: Register in index.ts**

Add import and registration in `server/src/index.ts`:

```typescript
import { exportImportRoute } from "./routes/exportImport.js";
// ... after other route registrations:
await server.register(exportImportRoute);
```

**Step 3: Commit**

```bash
git add server/src/routes/exportImport.ts server/src/index.ts
git commit -m "feat: add project export endpoint"
```

---

### Task 4: Server import route

**Files:**
- Modify: `server/src/routes/exportImport.ts`

**Step 1: Add import route to the same file**

Add inside the `exportImportRoute` function, after the export route:

```typescript
import AdmZip from "adm-zip";
import { writeFile, mkdir } from "node:fs/promises";
import multipart from "@fastify/multipart";
import type { ProjectState, ImportResponse, ErrorResponse } from "@lusk/shared";

// Import: POST /api/import
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

    // Read the uploaded file into a buffer
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Extract the zip
    const zip = new AdmZip(buffer);
    const sessionEntry = zip.getEntry("session.json");
    if (!sessionEntry) {
      return reply.status(400).send({ success: false, error: "Invalid .lusk file: missing session.json" });
    }

    const sessionData = JSON.parse(sessionEntry.getData().toString("utf-8")) as ProjectState;

    // Create a new session with a fresh ID
    const newSessionId = tempManager.createSession();
    const sessionDir = await tempManager.ensureSessionDir(newSessionId);

    // Rewrite the session data with the new ID and updated videoUrl
    const hasVideo = zip.getEntry("input.mp4") !== null;
    sessionData.sessionId = newSessionId;
    sessionData.videoUrl = hasVideo ? `/static/${newSessionId}/input.mp4` : null;
    // Clear render state (renders are not portable)
    sessionData.renders = {};
    sessionData.outputUrl = null;
    // If no video, set state back to IDLE so user can re-upload
    if (!hasVideo) {
      sessionData.state = "IDLE";
    }

    // Write session.json
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(sessionData, null, 2));

    // Write session-meta.json
    const meta = {
      sessionId: newSessionId,
      state: sessionData.state,
      videoUrl: sessionData.videoUrl,
      videoName: sessionData.videoName ?? null,
    };
    await writeFile(join(sessionDir, "session-meta.json"), JSON.stringify(meta));

    // Extract video if present
    if (hasVideo) {
      const videoEntry = zip.getEntry("input.mp4")!;
      await writeFile(join(sessionDir, "input.mp4"), videoEntry.getData());
    }

    // Restore into orchestrator
    orchestrator.restoreSession(sessionData);

    return {
      success: true as const,
      sessionId: newSessionId,
      videoName: sessionData.videoName ?? null,
    };
  }
);
```

**Note:** `@fastify/multipart` is already registered by the upload route plugin. Since Fastify doesn't allow double-registering the same plugin, we need to verify this works — the multipart plugin registered in `upload.ts` should apply app-wide. If not, we may need to restructure slightly (extract multipart registration to index.ts).

**Step 2: Commit**

```bash
git add server/src/routes/exportImport.ts
git commit -m "feat: add project import endpoint"
```

---

### Task 5: Client export UI

**Files:**
- Modify: `client/src/components/ClipSelector.tsx` (add export button to the clips view header)
- Modify: `client/src/App.tsx` (pass sessionId and videoName to ClipSelector)

**Step 1: Read ClipSelector.tsx to understand current props and layout**

**Step 2: Add export button with "Include source video" checkbox to ClipSelector header area**

The export button should:
1. Show a small dropdown/popover with a checkbox "Include source video" and an "Export" confirm button
2. On click, try `showSaveFilePicker` with suggested filename `{videoName}.lusk`
3. Fetch from `/api/project/${sessionId}/export?includeVideo=${checked}`
4. Pipe the response to the file handle, or fall back to standard download

```typescript
// Export handler (add inside ClipSelector or as a separate hook)
async function handleExport(sessionId: string, videoName: string, includeVideo: boolean) {
  const fileName = `${videoName || "project"}.lusk`;
  const url = `/api/project/${sessionId}/export?includeVideo=${includeVideo}`;

  // Try File System Access API
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: "Lusk Project",
          accept: { "application/zip": [".lusk"] },
        }],
      });
      const writable = await handle.createWritable();
      const response = await fetch(url);
      await response.body!.pipeTo(writable);
      return;
    } catch (err: any) {
      if (err.name === "AbortError") return; // User cancelled picker
      // Fall through to standard download
    }
  }

  // Fallback: standard download
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
```

**Step 3: Commit**

```bash
git add client/src/components/ClipSelector.tsx client/src/App.tsx
git commit -m "feat: add project export UI with File System Access API"
```

---

### Task 6: Client import UI

**Files:**
- Modify: `client/src/components/ResumeDialog.tsx` (add "Import Project" button)
- Modify: `client/src/components/UploadZone.tsx` (accept `.lusk` files in addition to video)
- Modify: `client/src/App.tsx` (add import handler, wire up callbacks)

**Step 1: Add import handler to App.tsx**

```typescript
const handleImport = useCallback(async (file: File) => {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("/api/import", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Import failed");
  }

  const data = await res.json();
  setSessionId(data.sessionId);
  setView("session");
}, []);
```

**Step 2: Add "Import Project" button to ResumeDialog**

Add alongside the "+ New project" button. Uses a hidden file input that accepts `.lusk` files.

```tsx
<label className="secondary import-btn">
  Import project
  <input type="file" accept=".lusk" onChange={(e) => {
    const file = e.target.files?.[0];
    if (file) onImport(file);
  }} hidden />
</label>
```

**Step 3: Update UploadZone to accept .lusk files**

In the `onDrop` and `onFileSelect` handlers, check if the file extension is `.lusk`. If so, call `onImport(file)` instead of `handleUpload(file)`.

Add `onImport?: (file: File) => void` to UploadZoneProps. Update the `accept` attribute to `"video/*,.lusk"`.

**Step 4: Commit**

```bash
git add client/src/components/ResumeDialog.tsx client/src/components/UploadZone.tsx client/src/App.tsx
git commit -m "feat: add project import UI with drag-drop support"
```

---

### Task 7: Manual testing checklist

1. Create a project, transcribe, add clips — export WITHOUT video. Verify `.lusk` file downloads and contains `session.json` + `session-meta.json` only.
2. Export WITH video. Verify `input.mp4` is in the archive.
3. Delete the session. Import the `.lusk` file with video. Verify session restores fully with clips, captions, transcript.
4. Import a `.lusk` file without video. Verify session appears but in a state that indicates no video.
5. Test File System Access API (Chrome) — verify save picker appears.
6. Test fallback (Firefox/Safari or cancel the picker) — verify standard download works.
7. Test drag-and-drop of `.lusk` file onto upload zone.
8. Test import button on sessions screen.
