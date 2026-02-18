# Phase 4: Real Remotion Server-Side Rendering

## Overview

Replace the mock render in `server/src/routes/render.ts` with actual Remotion server-side rendering using `@remotion/bundler` and `@remotion/renderer`. Output is a 1080x1920 H.264 MP4 at 6 Mbps using Apple VideoToolbox hardware acceleration.

## Approach

**Bundle + renderMedia** (standard Remotion SSR path):
1. Bundle the client composition once (cached in memory)
2. Call `renderMedia()` per clip with the user's inputProps
3. Progress pushed to client via existing SSE/orchestrator

## Changes

### 1. Remotion Entry Point

New files in `client/src/remotion/`:
- `index.ts` — calls `registerRoot(RemotionRoot)`
- `Root.tsx` — `<Composition>` wrapper for `VideoComposition` with ID, dimensions, FPS, default duration

The bundler points at `client/src/remotion/index.ts`.

### 2. API Contract

Expand `RenderRequest` in `shared/types.ts`:

```ts
export interface RenderRequest {
  sessionId: string;
  clip: ViralClip;
  offsetX: number;
}
```

Client sends clip + offsetX from StudioView. Response unchanged (fire-and-forget, progress via SSE).

### 3. RenderService (`server/src/services/RenderService.ts`)

- `ensureBundled()` — calls `bundle()` once, caches the bundle path
- `renderClip(sessionId, clip, offsetX, captions, videoPath)`:
  1. Computes inputProps server-side (absolute file path for video, filtered/shifted captions, offsetX, startFrom)
  2. `selectComposition()` with calculated `durationInFrames`
  3. `renderMedia()` with codec h264, 6 Mbps, h264_videotoolbox
  4. `onProgress` mapped to orchestrator updates
  5. Output to `.lusk_temp/{sessionId}/output.mp4`

### 4. Video URL Resolution

Server passes the absolute file path (`.lusk_temp/{sessionId}/input.mp4`) as `videoUrl` inputProp. Remotion's `<Video>` accepts local paths during server-side render.

### 5. Caption Prep (Server-Side)

The filtering/shifting logic from `StudioView.tsx` is replicated server-side:
- Filter captions to clip time range
- Shift startMs/endMs relative to clip start (using frame-quantized actualStartMs)

### 6. Route Update (`server/src/routes/render.ts`)

Replace `runMockRender` with call to `RenderService.renderClip()`. Extract clip and offsetX from expanded request body.

### 7. Dependencies

Add to `server/package.json`:
- `@remotion/bundler@4.0.424`
- `@remotion/renderer@4.0.424`
- `remotion@4.0.424`

## Data Flow

```
StudioView "Render Video" click
  → POST /api/render { sessionId, clip, offsetX }
  → RenderService.ensureBundled() (no-op if cached)
  → Compute inputProps (local video path, shifted captions, offsetX, startFrom)
  → selectComposition() with durationInFrames
  → renderMedia() → .lusk_temp/{sessionId}/output.mp4
  → orchestrator: RENDERING → EXPORTED
  → SSE → client shows download link
```

## What Stays The Same

- State machine: RENDERING → EXPORTED (no new states)
- VideoComposition component (unchanged)
- CaptionOverlay component (unchanged)
- SSE progress delivery
- Output URL pattern: `/static/{sessionId}/output.mp4`
