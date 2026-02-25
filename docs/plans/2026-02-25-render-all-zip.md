# Render All Clips & Download ZIP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Render All & Download ZIP" button to the clip grid that renders all clips sequentially (skipping already-rendered ones) and saves them as a zip to a user-specified path.

**Architecture:** Client-orchestrated sequential rendering using existing `/api/render` + SSE infrastructure, plus one new server endpoint `GET /api/sessions/:sessionId/clips-zip` that zips rendered clip files. No new shared types or SSE channels needed.

**Tech Stack:** Fastify + archiver (server), React + File System Access API / blob fallback (client), existing SSE state flow.

---

### Task 1: Server — clips-zip endpoint

**Files:**
- Modify: `server/src/routes/exportImport.ts`

**Step 1: Add `readdir` to the imports at the top of the file**

Current import line (line 3):
```typescript
import { access, stat } from "node:fs/promises";
```
Change to:
```typescript
import { access, stat, readdir } from "node:fs/promises";
```

**Step 2: Add the clips-zip route after the export route (before the import route)**

Add this block after the closing `}` of the `"/api/project/:sessionId/export"` handler (before line 84):

```typescript
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
        return reply.status(400).send({ success: false, error: "Session not found" });
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
        estimatedSize += 30 + f.name.length + s.size + 16 + 46 + f.name.length;
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
```

**Step 3: Start the server and verify the route exists**

```bash
cd /Users/atti/Source/Repos/lusk && npm run dev
```

Then in another terminal:
```bash
curl -I "http://localhost:3000/api/sessions/nonexistent/clips-zip"
```
Expected: HTTP 400 with `{"success":false,"error":"Session not found"}`

**Step 4: Commit**

```bash
git add server/src/routes/exportImport.ts
git commit -m "feat: add GET /api/sessions/:sessionId/clips-zip endpoint"
```

---

### Task 2: Pass `renders` and `captions` props to ClipSelector

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/ClipSelector.tsx` (interface only)

**Context:** `renders` lives in `state.renders` (SSE state in App.tsx). `captions` is `CaptionWord[]` state in App.tsx. Both need to flow into `ClipSelector` so it can run the batch queue.

**Step 1: Add `renders` and `captions` to the `ClipSelectorProps` interface in ClipSelector.tsx**

Find the `ClipSelectorProps` interface (around line 246) and add two props:

```typescript
interface ClipSelectorProps {
  clips: ViralClip[];
  videoUrl: string;
  sessionId: string;
  videoName: string | null;
  renders: Record<string, ClipRenderState>;
  captions: CaptionWord[];
  onSelect: (clip: ViralClip) => void;
  onBack: () => void;
  onAddClip: (clip: ViralClip) => void;
}
```

Also add the imports at the top of ClipSelector.tsx (line 2, after the existing import):
```typescript
import type { ViralClip, ClipRenderState, CaptionWord } from "@lusk/shared";
```
(Replace the existing `import type { ViralClip } from "@lusk/shared";`)

Also add `renders` and `captions` to the destructure in the `ClipSelector` function signature (line 256):
```typescript
export function ClipSelector({ clips, videoUrl, sessionId, videoName, renders, captions, onSelect, onBack, onAddClip }: ClipSelectorProps) {
```

**Step 2: Pass the new props in App.tsx**

Find the `<ClipSelector` JSX block (around line 446). It currently looks like:
```tsx
<ClipSelector
  clips={viralClips}
  videoUrl={state.videoUrl}
  sessionId={sessionId}
  videoName={state.videoName}
  onSelect={handleSelectClip}
  onBack={() => setReadySubView("review")}
  onAddClip={handleAddClip}
/>
```

Add the two new props:
```tsx
<ClipSelector
  clips={viralClips}
  videoUrl={state.videoUrl}
  sessionId={sessionId}
  videoName={state.videoName}
  renders={state.renders ?? {}}
  captions={captions}
  onSelect={handleSelectClip}
  onBack={() => setReadySubView("review")}
  onAddClip={handleAddClip}
/>
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/atti/Source/Repos/lusk && npm run build 2>&1 | head -30
```
Expected: No TypeScript errors. (Build may fail for other reasons — just check for no type errors.)

**Step 4: Commit**

```bash
git add client/src/App.tsx client/src/components/ClipSelector.tsx
git commit -m "feat: pass renders and captions props to ClipSelector"
```

---

### Task 3: Batch render logic in ClipSelector

**Files:**
- Modify: `client/src/components/ClipSelector.tsx`

**Context:** We need to:
1. Compute `remotionCaptions` for each clip (same logic as StudioView, but without UI state)
2. Watch `renders` prop changes to advance the queue when each clip finishes
3. Download the zip once all clips are done

The clip render key sent to the server = `${trimmedClip.startMs}-${trimmedClip.endMs}` where trimmedClip uses the effective (trimmed) boundaries.

**Step 1: Add necessary imports at the top of ClipSelector.tsx**

Add `useRef` to the existing import (line 1 currently has `useRef` — verify it's there; if not, add it):
```typescript
import { useRef, useEffect, useState, useCallback, type FormEvent } from "react";
```
(Already present — no change needed.)

Also add `type Caption` import (needed to type remotionCaptions):
```typescript
import type { Caption } from "@remotion/captions";
```
Add this after line 2 (after the @lusk/shared import).

**Step 2: Add helper functions before the `ClipSelector` component function**

Add these two pure helper functions after the `streamExport` function (around line 244, before the `ClipSelectorProps` interface):

```typescript
// Matches the CAPTION_DELAY_MS constant in StudioView
const CAPTION_DELAY_MS_BATCH = 900;
// Matches COMP_FPS in VideoComposition
const COMP_FPS_BATCH = 23.976;

/** Compute remotion-format captions for a clip, applying stored edits and offset. */
function buildRemotionCaptions(clip: ViralClip, allCaptions: CaptionWord[]): Caption[] {
  const trimStartDelta = clip.trimStartDelta ?? 0;
  const trimEndDelta = clip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH;
  const captionOffset = clip.captionOffset ?? 0;
  const captionEdits = clip.captionEdits ?? {};

  const effectiveStartMs = clip.startMs + trimStartDelta;
  const effectiveEndMs = clip.endMs + trimEndDelta;

  // Frame-align the start (matches RenderService logic)
  const startFrame = Math.round((effectiveStartMs / 1000) * COMP_FPS_BATCH);
  const actualStartMs = (startFrame / COMP_FPS_BATCH) * 1000;

  return allCaptions
    .map((c, globalIndex) => ({ c, globalIndex }))
    .filter(({ c }) => c.endMs > effectiveStartMs && c.startMs < effectiveEndMs)
    .map(({ c, globalIndex }) => ({
      text: captionEdits[globalIndex] ?? c.text,
      startMs: c.startMs - actualStartMs + captionOffset,
      endMs: c.endMs - actualStartMs + captionOffset,
      timestampMs: c.timestampMs != null ? c.timestampMs - actualStartMs + captionOffset : null,
      confidence: c.confidence,
    }));
}

/** Build the trimmed clip object that gets sent to /api/render. */
function buildTrimmedClip(clip: ViralClip): ViralClip {
  const trimStartDelta = clip.trimStartDelta ?? 0;
  const trimEndDelta = clip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH;
  return {
    ...clip,
    startMs: clip.startMs + trimStartDelta,
    endMs: clip.endMs + trimEndDelta,
  };
}

/** Stream the clips-zip from server to a file handle or blob download. */
async function downloadClipsZip(
  sessionId: string,
  fileHandle: FileSystemFileHandle | null,
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/clips-zip`);
  if (!response.ok) throw new Error("ZIP download failed");

  const reader = response.body!.getReader();

  let writableStream: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closeWritable: (() => Promise<void>) | null = null;
  let blobChunks: Uint8Array[] | null = null;

  if (fileHandle) {
    const writable = await fileHandle.createWritable();
    writableStream = writable.getWriter();
    closeWritable = async () => {
      writableStream!.releaseLock();
      await writable.close();
    };
  } else {
    blobChunks = [];
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (writableStream) await writableStream.write(value);
    else blobChunks!.push(value);
  }

  if (writableStream && closeWritable) {
    await closeWritable();
  } else if (blobChunks) {
    const blob = new Blob(blobChunks, { type: "application/zip" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = "clips.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }
}
```

**Step 3: Add batch state inside the `ClipSelector` function body**

Add these after the existing state declarations (after `const isExporting = ...` around line 263):

```typescript
  // ── Batch render state ─────────────────────────────────────────────────
  type BatchState = "idle" | "rendering" | "zipping" | "done";
  const [batchState, setBatchState] = useState<BatchState>("idle");
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDone, setBatchDone] = useState(0);
  const [batchError, setBatchError] = useState<string | null>(null);

  // Mutable batch control — not state to avoid stale closures
  const batchRef = useRef<{
    queue: ViralClip[];
    index: number;
    fileHandle: FileSystemFileHandle | null;
    currentKey: string | null;
    currentWasRendering: boolean;
  } | null>(null);
```

**Step 4: Add the batch queue watcher effect**

Add this `useEffect` after the existing `useEffect` hooks (after the `exportProgress` auto-hide effect, around line 285):

```typescript
  // Advance the batch queue whenever renders state changes
  useEffect(() => {
    const batch = batchRef.current;
    if (!batch || !batch.currentKey || batchState !== "rendering") return;

    const key = batch.currentKey;
    const renderState = renders[key];

    if (renderState?.status === "rendering") {
      batch.currentWasRendering = true;
      return;
    }

    const finished = renderState?.status === "exported";
    const failed = !renderState && batch.currentWasRendering;
    if (!finished && !failed) return;

    // Advance
    batch.index++;
    setBatchDone(batch.index);

    if (batch.index >= batch.queue.length) {
      // All clips done — download zip
      batch.currentKey = null;
      const handle = batch.fileHandle;
      batchRef.current = null;
      setBatchState("zipping");
      downloadClipsZip(sessionId, handle)
        .then(() => {
          setBatchState("done");
          setTimeout(() => setBatchState("idle"), 2000);
        })
        .catch((e: Error) => {
          setBatchError(e.message);
          setBatchState("idle");
        });
      return;
    }

    // Trigger next clip
    const nextClip = batch.queue[batch.index];
    batch.currentKey = `${nextClip.startMs + (nextClip.trimStartDelta ?? 0)}-${nextClip.endMs + (nextClip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH)}`;
    batch.currentWasRendering = false;

    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        clip: buildTrimmedClip(nextClip),
        offsetX: nextClip.speakerOffsetX ?? 0,
        captions: buildRemotionCaptions(nextClip, captions),
      }),
    });
  }, [renders, batchState, sessionId, captions]);
```

**Step 5: Add the `handleRenderAll` callback**

Add this after the `startExport` callback (around line 298):

```typescript
  const handleRenderAll = useCallback(async () => {
    setBatchError(null);

    // Build queue: clips not yet exported
    const pending = clips.filter((clip) => {
      const key = `${clip.startMs + (clip.trimStartDelta ?? 0)}-${clip.endMs + (clip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH)}`;
      return renders[key]?.status !== "exported";
    });

    if (pending.length === 0 && clips.length > 0) {
      // All clips already rendered — just zip
      let fileHandle: FileSystemFileHandle | null = null;
      if ("showSaveFilePicker" in window) {
        try {
          fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: "clips.zip",
            types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
          });
        } catch (err: any) {
          if (err.name === "AbortError") return;
        }
      }
      setBatchState("zipping");
      setBatchTotal(clips.length);
      setBatchDone(clips.length);
      downloadClipsZip(sessionId, fileHandle)
        .then(() => { setBatchState("done"); setTimeout(() => setBatchState("idle"), 2000); })
        .catch((e: Error) => { setBatchError(e.message); setBatchState("idle"); });
      return;
    }

    // Prompt for save destination before rendering starts
    let fileHandle: FileSystemFileHandle | null = null;
    if ("showSaveFilePicker" in window) {
      try {
        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: "clips.zip",
          types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
        });
      } catch (err: any) {
        if (err.name === "AbortError") return; // User cancelled — abort
      }
    }

    const firstClip = pending[0];
    const firstKey = `${firstClip.startMs + (firstClip.trimStartDelta ?? 0)}-${firstClip.endMs + (firstClip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH)}`;

    batchRef.current = {
      queue: pending,
      index: 0,
      fileHandle,
      currentKey: firstKey,
      currentWasRendering: false,
    };

    setBatchTotal(pending.length);
    setBatchDone(0);
    setBatchState("rendering");

    // Fire first render
    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        clip: buildTrimmedClip(firstClip),
        offsetX: firstClip.speakerOffsetX ?? 0,
        captions: buildRemotionCaptions(firstClip, captions),
      }),
    });
  }, [clips, renders, sessionId, captions]);
```

**Step 6: Verify TypeScript compiles**

```bash
cd /Users/atti/Source/Repos/lusk && npm run build 2>&1 | head -30
```
Expected: No TypeScript errors.

**Step 7: Commit**

```bash
git add client/src/components/ClipSelector.tsx
git commit -m "feat: add batch render queue logic to ClipSelector"
```

---

### Task 4: Render All button UI + CSS

**Files:**
- Modify: `client/src/components/ClipSelector.tsx` (JSX)
- Modify: `client/src/components/ClipSelector.css`

**Step 1: Add the "Render All" button to the header JSX**

In the `ClipSelector` return JSX, find the `<div className="export-wrapper"` block (around line 315). Add the batch button just before it:

```tsx
        {/* Render All & Download ZIP */}
        {clips.length > 0 && (
          <div className="render-all-wrapper">
            <button
              className="secondary render-all-btn"
              onClick={handleRenderAll}
              disabled={batchState === "rendering" || batchState === "zipping"}
              title={batchError ?? undefined}
            >
              {batchState === "rendering"
                ? `Rendering ${batchDone + 1} / ${batchTotal}…`
                : batchState === "zipping"
                ? "Saving ZIP…"
                : batchState === "done"
                ? "Done!"
                : "Render All & Download ZIP"}
            </button>
            {batchError && (
              <p className="render-all-error">{batchError}</p>
            )}
          </div>
        )}
```

The full header should look like (the `clip-selector-header` div):

```tsx
      <div className="clip-selector-header">
        <button className="secondary studio-back" onClick={onBack}>
          {/* ... back arrow svg ... */}
          Back to Review
        </button>
        <div className="clip-selector-title-group">
          <h2>Pick a clip to edit</h2>
          <p className="subtitle">
            {clips.length} clip{clips.length !== 1 ? "s" : ""}
          </p>
        </div>
        {clips.length > 0 && (
          <div className="render-all-wrapper">
            <button
              className="secondary render-all-btn"
              onClick={handleRenderAll}
              disabled={batchState === "rendering" || batchState === "zipping"}
              title={batchError ?? undefined}
            >
              {batchState === "rendering"
                ? `Rendering ${batchDone + 1} / ${batchTotal}…`
                : batchState === "zipping"
                ? "Saving ZIP…"
                : batchState === "done"
                ? "Done!"
                : "Render All & Download ZIP"}
            </button>
            {batchError && <p className="render-all-error">{batchError}</p>}
          </div>
        )}
        <div className="export-wrapper" ref={exportRef}>
          {/* ... existing export dropdown ... */}
        </div>
      </div>
```

**Important:** The header currently uses `position: absolute` for the left/right items. The new button sits between the center title-group and the export-wrapper. Review the existing CSS — if the layout breaks, see the CSS step below.

**Step 2: Add CSS for the new elements**

Append to `client/src/components/ClipSelector.css`:

```css
/* ── Render All Button ── */

.render-all-wrapper {
  position: absolute;
  right: 160px; /* Offset left of the export button (~150px wide + gap) */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.25rem;
}

.render-all-btn {
  font-size: 0.82rem;
  padding: 0.4rem 0.75rem;
  white-space: nowrap;
}

.render-all-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.render-all-error {
  font-size: 0.75rem;
  color: var(--error);
  margin: 0;
  max-width: 180px;
  text-align: right;
}
```

**Step 3: Verify the UI renders correctly**

Start the dev server:
```bash
npm run dev
```

1. Open http://localhost:5173
2. Resume or upload a session with at least 2 clips
3. Navigate to the clip grid — you should see "Render All & Download ZIP" button in the header
4. Click it — a save dialog should appear
5. After picking a destination, the first clip should start rendering (visible via the existing per-clip render indicator in StudioView if you enter studio for that clip, or watch the button label change)
6. After all clips render, the ZIP should save to the chosen path

**Step 4: Commit**

```bash
git add client/src/components/ClipSelector.tsx client/src/components/ClipSelector.css
git commit -m "feat: add Render All & Download ZIP button UI to ClipSelector"
```

---

## Testing Checklist

- [ ] `GET /api/sessions/:sessionId/clips-zip` returns 400 for unknown sessions
- [ ] `GET /api/sessions/:sessionId/clips-zip` returns 404 when no clips are rendered yet
- [ ] After rendering one clip manually, the endpoint returns a valid zip with that clip
- [ ] "Render All" button appears in clip grid header when clips exist
- [ ] Clicking "Render All" opens `showSaveFilePicker` (in Chrome) or auto-downloads (in older browsers)
- [ ] Cancelling the file picker aborts without starting any renders
- [ ] Already-rendered clips are skipped in the queue
- [ ] Button label updates: "Rendering 1 / 3…", "Rendering 2 / 3…", "Saving ZIP…", "Done!"
- [ ] If a clip render fails (delete the session dir file mid-render), the batch continues to the next clip
- [ ] The downloaded zip contains `.mp4` files named after clip titles
