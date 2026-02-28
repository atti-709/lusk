# Vertical Video Preview & Align Captions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support vertical (9:16) source videos correctly throughout the pipeline — fix oversized previews, fix wrong scaling in the Remotion composition, and show captions during the align phase.

**Architecture:** Three independent streams of work: (A) CSS-only max-height cap for the raw `<video>` previews, (B) server-side dimension probing so clients know if the source is vertical, (C) conditional `VideoComposition` scaling driven by that data. Plus a fourth stream: fetching whisper captions in the ALIGNING phase and rendering a Remotion Player inside PipelineStepper.

**Tech Stack:** TypeScript, React, Remotion, Fastify, ffprobe (dimensions), SSE (ProjectState broadcast).

---

## Task 1: Cap the raw `<video>` preview height (CSS only)

**Files:**
- Modify: `client/src/components/PipelineStepper.css:112-115`

The `.video-preview video` block currently has `width: 100%; display: block;`.
For a vertical source at `max-width: 640px`, the video renders ~1138 px tall — way off-screen.

**Step 1: Edit PipelineStepper.css**

Replace:
```css
.video-preview video {
  width: 100%;
  display: block;
}
```
With:
```css
.video-preview video {
  width: 100%;
  max-height: 65vh;
  object-fit: contain;
  display: block;
}
```

`object-fit: contain` keeps the full frame visible inside the capped height.
For landscape sources nothing changes visually (65 vh is plenty for a 16:9 video at 640 px wide).

**Step 2: TypeScript compile check**

```bash
cd /Users/atti/Source/Repos/lusk/.worktrees/gemini-automation
npm run build -w client 2>&1 | tail -5
```
Expected: clean build (CSS is not type-checked, but this confirms no regressions).

**Step 3: Commit**

```bash
cd /Users/atti/Source/Repos/lusk/.worktrees/gemini-automation
git add client/src/components/PipelineStepper.css
git commit -m "fix: cap vertical video preview height to 65vh"
```

---

## Task 2: Add `videoWidth` / `videoHeight` to shared types

**Files:**
- Modify: `shared/types.ts:76-91` (`ProjectData` interface)

**Step 1: Edit shared/types.ts**

In the `ProjectData` interface, add two optional nullable fields after `videoDurationMs`:

```typescript
  videoDurationMs: number | null;
  videoWidth: number | null;   // source pixel width
  videoHeight: number | null;  // source pixel height
```

**Step 2: Compile shared package**

```bash
cd /Users/atti/Source/Repos/lusk/.worktrees/gemini-automation
npm run build -w shared 2>&1 | tail -5
```
Expected: clean.

**Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add videoWidth/videoHeight to ProjectData shared type"
```

---

## Task 3: Probe video dimensions on `select-video` (server route)

**Files:**
- Modify: `server/src/routes/projects.ts:19-31` (the local `probeVideoDurationMs` helper)
- Modify: `server/src/routes/projects.ts:147-158` (the `select-video` handler body)

There is already a `probeVideoDurationMs()` helper in this file that calls `ffprobe -show_format`.
We need a second helper (or an extended one) that also fetches video stream dimensions via `-show_streams`.

**Step 1: Add `probeVideoMeta()` helper after the existing `probeVideoDurationMs` in projects.ts**

```typescript
/** Probe video width, height (first video stream). Returns null values on failure. */
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
```

**Step 2: Call it inside the `select-video` handler**

Find the block that sets session fields (around line 151-157). Add the dimension probe call and set the new fields:

```typescript
      session.videoPath = videoPath;
      session.videoUrl = `/static/${projectId}/input.mp4`;
      session.videoDurationMs = probeVideoDurationMs(videoPath);
      const meta = probeVideoMeta(videoPath);
      session.videoWidth = meta.width;
      session.videoHeight = meta.height;
      session.state = "UPLOADING";
```

**Step 3: Build server**

```bash
cd /Users/atti/Source/Repos/lusk/.worktrees/gemini-automation
npm run build -w shared && npm run build -w server 2>&1 | tail -10
```
Expected: clean TypeScript build.

**Step 4: Commit**

```bash
git add server/src/routes/projects.ts
git commit -m "feat: probe and store video dimensions on video selection"
```

---

## Task 4: Probe video dimensions on project file restore (ProjectFileService)

**Files:**
- Modify: `server/src/services/ProjectFileService.ts:49-62` (the `probeVideoDurationMs` helper)

`ProjectFileService` has its own copy of `probeVideoDurationMs`. We need the same `probeVideoMeta` helper here so that dimensions are populated when an existing project is loaded from disk.

**Step 1: Add `probeVideoMeta()` helper after `probeVideoDurationMs` in ProjectFileService.ts**

Same implementation as Task 3 Step 1 — copy it verbatim into `ProjectFileService.ts` after the existing duration probe function.

**Step 2: Find where `videoDurationMs` is set during restore and add dimension fields**

Search for `videoDurationMs` assignments in `ProjectFileService.ts`. There will be one or more places where session data is constructed from a loaded `.lusk` file. Add:

```typescript
const meta = probeVideoMeta(session.videoPath);
session.videoWidth = session.videoWidth ?? meta.width;
session.videoHeight = session.videoHeight ?? meta.height;
```

The `??` guard means if the project file already has dimensions (future saves), we keep them; otherwise we re-probe.

**Step 3: Build server**

```bash
npm run build -w server 2>&1 | tail -10
```
Expected: clean.

**Step 4: Commit**

```bash
git add server/src/services/ProjectFileService.ts
git commit -m "feat: probe video dimensions on project file restore"
```

---

## Task 5: Conditional scaling in VideoComposition

**Files:**
- Modify: `client/src/components/VideoComposition.tsx`

Currently `ClipVideo` hardcodes `width: "177.78%"` — the factor to scale a 16:9 source to cover a 9:16 (1080×1920) frame.
For a vertical source this over-zooms massively. When source is portrait, `width: 100%; height: 100%; object-fit: cover` is correct.

**Step 1: Add `sourceAspectRatio` prop to `VideoCompositionProps`**

```typescript
export type VideoCompositionProps = {
  videoUrl: string;
  captions: Caption[];
  offsetX: number;
  startFrom?: number;
  outroSrc?: string;
  outroDurationInFrames?: number;
  sourceAspectRatio?: number | null;  // videoWidth / videoHeight; null → assume landscape
};
```

**Step 2: Thread `sourceAspectRatio` through to `ClipVideo`**

Add it to `ClipVideo`'s props:

```typescript
function ClipVideo({
  src,
  startFrom,
  offsetX,
  clipDurationInFrames,
  sourceAspectRatio,
}: {
  src: string;
  startFrom: number;
  offsetX: number;
  clipDurationInFrames: number;
  sourceAspectRatio?: number | null;
}) {
```

**Step 3: Use `sourceAspectRatio` to choose the scale strategy**

Inside `ClipVideo`, replace the hardcoded style with conditional logic:

```typescript
  // Portrait source (9:16 or narrower): already fills the vertical frame — no scale needed.
  // Landscape source (16:9): must scale width to 177.78% so height fills frame.
  const isPortrait = sourceAspectRatio != null && sourceAspectRatio < 1;

  const videoStyle: React.CSSProperties = isPortrait
    ? {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        position: "absolute",
        left: 0,
        top: 0,
      }
    : {
        width: "177.78%",
        height: "100%",
        objectFit: "cover",
        position: "absolute",
        left: "50%",
        transform: `translateX(calc(-50% + ${offsetX}px))`,
      };
```

Replace the `style={{...}}` on `<OffthreadVideo>` with `style={videoStyle}`.

**Step 4: Forward `sourceAspectRatio` from `VideoComposition` to `ClipVideo`**

In `VideoComposition`, destructure the new prop and pass it down:

```typescript
export function VideoComposition({
  videoUrl,
  captions,
  offsetX,
  startFrom = 0,
  outroSrc,
  outroDurationInFrames = 0,
  sourceAspectRatio,
}: VideoCompositionProps) {
```

And in the JSX:
```tsx
<ClipVideo
  src={videoUrl}
  startFrom={startFrom}
  offsetX={offsetX}
  clipDurationInFrames={clipDurationInFrames}
  sourceAspectRatio={sourceAspectRatio}
/>
```

**Step 5: Build client**

```bash
npm run build -w client 2>&1 | tail -10
```
Expected: clean.

**Step 6: Commit**

```bash
git add client/src/components/VideoComposition.tsx
git commit -m "feat: conditional video scaling in VideoComposition for vertical source"
```

---

## Task 6: Wire `sourceAspectRatio` through App.tsx to all players

**Files:**
- Modify: `client/src/App.tsx`

`state` comes from SSE and now has `videoWidth` / `videoHeight`. Derive `sourceAspectRatio` once in App.tsx and pass it to every `<Player component={VideoComposition}>` and to `StudioView`.

**Step 1: Derive `sourceAspectRatio` near top of the render function**

Add after the existing `isReady`/`isStudio` derivations (around line 43):

```typescript
  const sourceAspectRatio = useMemo(() => {
    if (!state?.videoWidth || !state?.videoHeight) return null;
    return state.videoWidth / state.videoHeight;
  }, [state?.videoWidth, state?.videoHeight]);
```

**Step 2: Pass `sourceAspectRatio` to the Review Player (line ~607)**

Find the Remotion `<Player>` in the review step and update its `inputProps`:

```typescript
  inputProps={{
    videoUrl: state.videoUrl,
    captions: fullVideoCaptions,
    offsetX: 0,
    startFrom: 0,
    sourceAspectRatio,
  }}
```

**Step 3: Pass `sourceAspectRatio` to StudioView (line ~711)**

```tsx
<StudioView
  ...
  sourceAspectRatio={sourceAspectRatio}
  ...
/>
```

**Step 4: Build client**

```bash
npm run build -w client 2>&1 | tail -10
```
Expected: TypeScript errors about `sourceAspectRatio` not being in `StudioViewProps` — fix those in the next task.

**Step 5: Commit (after Task 7 fixes compile)**

Will be committed together with Task 7.

---

## Task 7: Accept `sourceAspectRatio` in StudioView, hide offsetX for vertical source

**Files:**
- Modify: `client/src/components/StudioView.tsx`

**Step 1: Add `sourceAspectRatio` to `StudioViewProps`**

```typescript
interface StudioViewProps {
  videoUrl: string;
  captions: CaptionWord[];
  clip: ViralClip;
  videoName: string | null;
  onRender: (clip: ViralClip, offsetX: number, captions: Caption[]) => void;
  onBack: () => void;
  renders: Record<string, ClipRenderState>;
  onClipUpdate: (clip: ViralClip) => void;
  sourceAspectRatio?: number | null;
}
```

**Step 2: Destructure and derive `isVerticalSource`**

```typescript
export function StudioView({ ..., sourceAspectRatio }: StudioViewProps) {
  const isVerticalSource = sourceAspectRatio != null && sourceAspectRatio < 1;
```

**Step 3: Pass `sourceAspectRatio` to the Remotion Player `inputProps`**

Find the Player `inputProps` in StudioView and add:
```typescript
sourceAspectRatio,
```

**Step 4: Conditionally hide the "Speaker position" slider**

Find the `offsetX` / speaker position slider section. Wrap it:

```tsx
{!isVerticalSource && (
  <div className="control-group">
    {/* ... existing speaker position slider ... */}
  </div>
)}
```

**Step 5: Build client**

```bash
npm run build -w client 2>&1 | tail -10
```
Expected: clean.

**Step 6: Commit Tasks 6 + 7 together**

```bash
git add client/src/App.tsx client/src/components/StudioView.tsx
git commit -m "feat: wire sourceAspectRatio through App and StudioView, hide offsetX for vertical source"
```

---

## Task 8: Fetch captions when entering ALIGNING state (App.tsx)

**Files:**
- Modify: `client/src/App.tsx`

Currently, captions are only fetched when `isReady`. We need them for the ALIGNING phase preview. The cleanest approach: add a second `useEffect` that fetches captions when `state.state === "ALIGNING"` and captions are not yet loaded.

**Step 1: Add ALIGNING-phase captions fetch useEffect**

Add after the existing `useEffect` that fetches on `isReady` (around line 100):

```typescript
  // Fetch captions when entering ALIGNING state (for preview during alignment)
  useEffect(() => {
    if (!sessionId || !state || state.state !== "ALIGNING" || captions.length > 0) return;

    let isMounted = true;
    fetch(`/api/projects/${sessionId}`)
      .then((r) => r.json())
      .then((data: ProjectState) => {
        if (!isMounted || !data.captions) return;
        setCaptions(data.captions);
      })
      .catch(() => {});

    return () => { isMounted = false; };
  }, [sessionId, state?.state]);  // only re-run when state.state changes
```

**Step 2: Build client**

```bash
npm run build -w client 2>&1 | tail -10
```
Expected: clean.

**Step 3: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: fetch whisper captions when entering ALIGNING state for preview"
```

---

## Task 9: Remotion Player inside PipelineStepper during ALIGNING

**Files:**
- Modify: `client/src/components/PipelineStepper.tsx`
- Modify: `client/src/components/PipelineStepper.css`
- Modify: `client/src/App.tsx` (pass captions + sourceAspectRatio to PipelineStepper)

This is the most visible change: show a live Remotion Player with TikTok-style captions above the progress bar and AlignStep form during the ALIGNING phase.

### Step 1: Add props to PipelineStepper

In `PipelineStepper.tsx`, extend `PipelineStepperProps`:

```typescript
interface PipelineStepperProps {
  currentState: PipelineState;
  progress: number;
  message: string;
  videoUrl: string | null;
  sessionId: string;
  readySubView?: ReadySubView;
  whisperxAvailable?: boolean;
  geminiAvailable?: boolean;
  captions?: CaptionWord[];           // whisper captions for align preview
  sourceAspectRatio?: number | null;  // for correct video scaling
}
```

Add the imports at top of file:

```typescript
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord } from "@lusk/shared";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
} from "./VideoComposition";
```

### Step 2: Derive caption data for the player

Inside `PipelineStepper`, convert `CaptionWord[]` → `Caption[]` (same mapping as App.tsx review step):

```typescript
  const remotionCaptions: Caption[] = useMemo(
    () =>
      (captions ?? []).map((c) => ({
        text: c.text,
        startMs: c.startMs,
        endMs: c.endMs,
        timestampMs: c.timestampMs,
        confidence: c.confidence,
      })),
    [captions]
  );

  const durationInFrames = useMemo(() => {
    const last = (captions ?? []).at(-1);
    if (!last) return 1;
    return Math.max(1, Math.ceil(((last.endMs + 1000) / 1000) * COMP_FPS));
  }, [captions]);
```

Add `useMemo` import to the file's React imports.

### Step 3: Render Remotion Player during ALIGNING

Replace the existing video preview block:

```tsx
{/* Video preview (only during pre-READY pipeline) */}
{videoUrl && !showAlignStep && currentState !== "READY" && (
  <div className="video-preview">
    <video src={videoUrl} controls />
  </div>
)}
```

With this new block that handles three cases:

```tsx
{/* Video preview during UPLOADING/TRANSCRIBING (plain video, no captions yet) */}
{videoUrl && currentState !== "READY" && currentState !== "ALIGNING" && (
  <div className="video-preview">
    <video src={videoUrl} controls />
  </div>
)}

{/* Remotion Player with captions during ALIGNING */}
{videoUrl && currentState === "ALIGNING" && remotionCaptions.length > 0 && (
  <div className="align-preview-player">
    <Player
      component={VideoComposition}
      inputProps={{
        videoUrl,
        captions: remotionCaptions,
        offsetX: 0,
        startFrom: 0,
        sourceAspectRatio,
      }}
      compositionWidth={COMP_WIDTH}
      compositionHeight={COMP_HEIGHT}
      durationInFrames={durationInFrames}
      fps={COMP_FPS}
      style={{
        width: "100%",
        maxHeight: "65vh",
        borderRadius: 12,
        overflow: "hidden",
      }}
      controls
      loop
    />
  </div>
)}

{/* Fallback: plain video during ALIGNING if captions not yet loaded */}
{videoUrl && currentState === "ALIGNING" && remotionCaptions.length === 0 && (
  <div className="video-preview">
    <video src={videoUrl} controls />
  </div>
)}
```

### Step 4: Add `.align-preview-player` CSS

In `PipelineStepper.css`, add after the `.video-preview` block:

```css
/* ── Align phase preview player ── */
.align-preview-player {
  width: 100%;
  max-width: 400px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}
```

### Step 5: Pass captions + sourceAspectRatio from App.tsx to PipelineStepper

In `App.tsx`, find the `<PipelineStepper .../>` render (around line 502). Add the two new props:

```tsx
<PipelineStepper
  currentState={state.state}
  progress={state.progress}
  message={state.message}
  videoUrl={state.videoUrl}
  sessionId={sessionId}
  readySubView={readySubView}
  whisperxAvailable={whisperxAvailable}
  geminiAvailable={geminiAvailable}
  captions={captions}
  sourceAspectRatio={sourceAspectRatio}
/>
```

### Step 6: Build

```bash
npm run build -w shared && npm run build -w client 2>&1 | tail -10
```
Expected: clean.

### Step 7: Commit

```bash
git add client/src/components/PipelineStepper.tsx \
        client/src/components/PipelineStepper.css \
        client/src/App.tsx
git commit -m "feat: show Remotion caption preview during ALIGNING phase"
```

---

## Final Verification

```bash
cd /Users/atti/Source/Repos/lusk/.worktrees/gemini-automation
npm run build 2>&1 | tail -15
```

Expected: all workspaces (shared, server, client) build clean with no TypeScript errors.
