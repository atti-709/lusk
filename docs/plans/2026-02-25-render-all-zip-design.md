# Design: Render All Clips & Download as ZIP

**Date:** 2026-02-25
**Branch:** project-export

## Goal

Add a "Render All & Download ZIP" button to the clip grid that:
1. Renders all clips sequentially (skipping already-rendered ones)
2. Zips all rendered clip videos
3. Saves the zip to a user-specified destination via the File System Access API

## Approach

Option A — client-orchestrated sequential rendering + new server zip endpoint.

Reuses existing `/api/render` and SSE infrastructure. Only new server piece is a zip-streaming endpoint.

## New Server Endpoint

**`GET /api/sessions/:sessionId/clips-zip`**

- Reads all `output_*.mp4` files from `.lusk_temp/{sessionId}/`
- Zips them using `archiver` (already a dependency)
- Names each entry inside the zip as `{clip-title}.mp4`, matched by `startMs-endMs` key against `session.json` viralClips
- Streams zip directly in response: `Content-Disposition: attachment; filename="clips.zip"`
- Returns 404 if no rendered clips exist, 400 if session unknown

## Client — Render Queue Logic

Inline state in `ClipSelector`:

```
batchState: 'idle' | 'rendering' | 'done'
currentIndex: number
```

**Flow:**
1. User clicks "Render All & Download ZIP"
2. `showSaveFilePicker` (falls back to blob download if unavailable) — user picks destination
3. Build ordered list: all clips where `renders[key]?.status !== 'exported'`
4. `POST /api/render` for first pending clip
5. Watch SSE `state.renders[key].status` → when `'exported'`, trigger next clip
6. On queue exhausted: `GET /api/sessions/:sessionId/clips-zip`, stream to the file handle
7. Reset to idle

## Client — UI Changes (ClipSelector)

- "Render All & Download ZIP" button in clip grid header (beside "Add Clip")
- While running: button shows "Rendering X / Y…" (disabled)
- Individual clip cards retain per-clip progress indicators as-is
- Batch state is local to `ClipSelector` — no changes to `App.tsx` or shared types

## Error Handling

- Individual clip render failure (SSE shows error / render key deleted): skip that clip, continue queue
- ZIP download failure: show inline error below the button
- `showSaveFilePicker` cancelled: abort before any renders start

## Data Flow

```
ClipSelector: click "Render All"
  → showSaveFilePicker() → user picks path
  → POST /api/render (clip 1)
  → SSE: renders[key].status = "exported"
  → POST /api/render (clip 2) ...
  → all clips done
  → GET /api/sessions/:sessionId/clips-zip
  → stream to FileSystemWritableFileStream (or blob fallback)
  → done
```

## Files to Change

| File | Change |
|------|--------|
| `server/src/routes/exportImport.ts` | Add `GET /api/sessions/:sessionId/clips-zip` route |
| `server/src/index.ts` | Register new route (if needed) |
| `client/src/components/ClipSelector.tsx` | Add batch render button + queue logic |

No changes to `shared/types.ts`, `Orchestrator.ts`, or `App.tsx`.
