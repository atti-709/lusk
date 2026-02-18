# Phase 4: Real Remotion Server-Side Rendering — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the mock render with real Remotion server-side rendering that produces a 1080x1920 H.264 MP4 using Apple VideoToolbox hardware acceleration.

**Architecture:** The server bundles the client's VideoComposition once (cached in memory), then calls `renderMedia()` per clip. Caption filtering/shifting and frame calculations happen server-side. Progress is reported through the existing SSE/orchestrator pipeline.

**Tech Stack:** `@remotion/bundler` + `@remotion/renderer` v4.0.424, `h264` codec, `hardwareAcceleration: 'if-possible'`, `videoBitrate: '6000k'`

---

### Task 1: Install Remotion rendering dependencies

**Files:**
- Modify: `server/package.json`

**Step 1: Install packages**

Run:
```bash
cd server && npm install @remotion/bundler@4.0.424 @remotion/renderer@4.0.424 remotion@4.0.424
```

The `remotion` core package is needed because `@remotion/renderer` peers on it.

**Step 2: Verify installation**

Run: `cd server && node -e "require('@remotion/bundler'); require('@remotion/renderer'); console.log('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(server): add @remotion/bundler and @remotion/renderer"
```

---

### Task 2: Create Remotion entry point

**Files:**
- Create: `client/src/remotion/index.ts`
- Create: `client/src/remotion/Root.tsx`

**Step 1: Create the entry file**

`client/src/remotion/index.ts`:
```ts
import { registerRoot } from "remotion";
import { Root } from "./Root";
registerRoot(Root);
```

**Step 2: Create the Root composition wrapper**

`client/src/remotion/Root.tsx`:
```ts
import { Composition } from "remotion";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
} from "../components/VideoComposition";
import type { VideoCompositionProps } from "../components/VideoComposition";

export function Root() {
  return (
    <Composition<VideoCompositionProps>
      id="LuskClip"
      component={VideoComposition}
      width={COMP_WIDTH}
      height={COMP_HEIGHT}
      fps={COMP_FPS}
      durationInFrames={1}
      defaultProps={{
        videoUrl: "",
        captions: [],
        offsetX: 0,
        startFrom: 0,
      }}
    />
  );
}
```

`durationInFrames` is a placeholder — overridden at render time via `selectComposition`.

**Step 3: Commit**

```bash
git add client/src/remotion/
git commit -m "feat(client): add Remotion entry point for server-side rendering"
```

---

### Task 3: Expand RenderRequest API contract

**Files:**
- Modify: `shared/types.ts`
- Modify: `client/src/components/StudioView.tsx`
- Modify: `client/src/App.tsx`

**Step 1: Update the shared type**

In `shared/types.ts`, change `RenderRequest`:

```ts
export interface RenderRequest {
  sessionId: string;
  clip: ViralClip;
  offsetX: number;
}
```

**Step 2: Update StudioView to pass offsetX through onRender**

In `client/src/components/StudioView.tsx`:

Change the `onRender` prop type:
```ts
onRender: (clip: ViralClip, offsetX: number) => void;
```

Change the button onClick:
```ts
onClick={() => onRender(clip, offsetX)}
```

**Step 3: Update App.tsx handleRender**

In `client/src/App.tsx`, update the callback:

```ts
const handleRender = useCallback(
  async (clip: ViralClip, offsetX: number) => {
    if (!sessionId) return;
    await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, clip, offsetX }),
    });
  },
  [sessionId]
);
```

**Step 4: Rebuild shared types**

Run: `cd shared && npm run build` (or `tsc`)

**Step 5: Commit**

```bash
git add shared/types.ts client/src/components/StudioView.tsx client/src/App.tsx
git commit -m "feat: expand RenderRequest to include clip and offsetX"
```

---

### Task 4: Create RenderService

**Files:**
- Create: `server/src/services/RenderService.ts`

This is the core of the implementation. The service has two methods:

- `ensureBundled()` — bundles once, caches the path
- `renderClip()` — renders a single clip to MP4

**Step 1: Write RenderService**

`server/src/services/RenderService.ts`:
```ts
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { CaptionWord } from "@lusk/shared";
import type { Caption } from "@remotion/captions";

const COMP_FPS = 23.976;
const COMPOSITION_ID = "LuskClip";

type ProgressCallback = (percent: number, message: string) => void;

class RenderService {
  private bundlePath: string | null = null;

  private get entryPoint(): string {
    return path.resolve(
      import.meta.dirname,
      "../../../client/src/remotion/index.ts"
    );
  }

  async ensureBundled(onProgress?: ProgressCallback): Promise<string> {
    if (this.bundlePath) return this.bundlePath;

    onProgress?.(5, "Bundling composition...");
    this.bundlePath = await bundle({
      entryPoint: this.entryPoint,
      onProgress: (progress) => {
        onProgress?.(5 + Math.round(progress * 15), "Bundling composition...");
      },
    });
    onProgress?.(20, "Bundle ready");
    return this.bundlePath;
  }

  async renderClip(
    sessionDir: string,
    clip: { startMs: number; endMs: number },
    offsetX: number,
    captions: CaptionWord[],
    onProgress?: ProgressCallback
  ): Promise<string> {
    const serveUrl = await this.ensureBundled(onProgress);
    const videoPath = path.join(sessionDir, "input.mp4");
    const outputPath = path.join(sessionDir, "output.mp4");

    // Replicate the frame quantization from StudioView
    const startFrame = Math.round((clip.startMs / 1000) * COMP_FPS);
    const actualStartMs = (startFrame / COMP_FPS) * 1000;
    const durationInFrames = Math.max(
      1,
      Math.ceil(((clip.endMs - actualStartMs) / 1000) * COMP_FPS)
    );

    // Filter and shift captions to clip-relative timing
    const remotionCaptions: Caption[] = captions
      .filter((c) => c.endMs > clip.startMs && c.startMs < clip.endMs)
      .map((c) => ({
        text: c.text,
        startMs: c.startMs - actualStartMs,
        endMs: c.endMs - actualStartMs,
        timestampMs: c.timestampMs != null ? c.timestampMs - actualStartMs : null,
        confidence: c.confidence,
      }));

    const inputProps = {
      videoUrl: videoPath,
      captions: remotionCaptions,
      offsetX,
      startFrom: startFrame,
    };

    onProgress?.(20, "Preparing composition...");

    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });

    // Override duration for this specific clip
    composition.durationInFrames = durationInFrames;

    onProgress?.(25, "Rendering video...");

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      videoBitrate: "6000k",
      hardwareAcceleration: "if-possible",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        const pct = 25 + Math.round(progress * 70);
        onProgress?.(pct, "Rendering video...");
      },
    });

    onProgress?.(95, "Render complete");
    return outputPath;
  }
}

export const renderService = new RenderService();
export { RenderService };
```

**Step 2: Commit**

```bash
git add server/src/services/RenderService.ts
git commit -m "feat(server): add RenderService with Remotion bundle + renderMedia"
```

---

### Task 5: Wire up render route

**Files:**
- Modify: `server/src/routes/render.ts`

**Step 1: Replace mock render with real render**

Rewrite `server/src/routes/render.ts`:

```ts
import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";
import { renderService } from "../services/RenderService.js";
import type { RenderRequest, ErrorResponse } from "@lusk/shared";

async function runRender(
  sessionId: string,
  clip: RenderRequest["clip"],
  offsetX: number,
  log: FastifyInstance["log"]
): Promise<void> {
  orchestrator.transition(sessionId, "RENDERING");

  const session = orchestrator.getSession(sessionId)!;
  const sessionDir = tempManager.getSessionDir(sessionId);
  const captions = session.captions ?? [];

  try {
    await renderService.renderClip(
      sessionDir,
      clip,
      offsetX,
      captions,
      (percent, message) => {
        orchestrator.updateProgress(sessionId, percent, message);
      }
    );

    const outputUrl = `/static/${sessionId}/output.mp4`;
    orchestrator.setOutputUrl(sessionId, outputUrl);
    orchestrator.transition(sessionId, "EXPORTED");
    orchestrator.updateProgress(sessionId, 100, "Export complete — ready to download");
  } catch (err) {
    log.error(err, "Render failed");
    orchestrator.updateProgress(sessionId, 0, "Render failed");
    // Transition back to READY so user can retry
    orchestrator.transition(sessionId, "READY");
  }
}

export async function renderRoute(app: FastifyInstance) {
  app.post<{ Body: RenderRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/render",
    async (request, reply) => {
      const { sessionId, clip, offsetX } =
        (request.body ?? {}) as Partial<RenderRequest>;

      if (!sessionId || !clip) {
        return reply
          .status(400)
          .send({ success: false, error: "sessionId and clip are required" });
      }

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply
          .status(404)
          .send({ success: false, error: "Session not found" });
      }

      if (session.state !== "READY") {
        return reply
          .status(409)
          .send({
            success: false,
            error: `Cannot render in state: ${session.state}`,
          });
      }

      // Fire-and-forget
      runRender(sessionId, clip, offsetX ?? 0, app.log).catch((err) => {
        app.log.error(err, "Render pipeline failed");
      });

      return { success: true as const };
    }
  );
}
```

**Step 2: Commit**

```bash
git add server/src/routes/render.ts
git commit -m "feat(server): replace mock render with real Remotion renderMedia"
```

---

### Task 6: Handle READY ← RENDERING transition for retry

**Files:**
- Modify: `server/src/services/Orchestrator.ts`

The render route catches errors and transitions back to `READY`. Check that the Orchestrator's state machine allows `RENDERING → READY`. If it doesn't, add this transition.

**Step 1: Read Orchestrator.ts and check transition logic**

Look for the transition validation. If it's an explicit allow-list, add `RENDERING → READY`.

**Step 2: Add transition if needed**

If there's validation like a `validTransitions` map, add:
```ts
RENDERING: ["EXPORTED", "READY"],
```

**Step 3: Commit (if changed)**

```bash
git add server/src/services/Orchestrator.ts
git commit -m "fix(server): allow RENDERING → READY transition for render retry"
```

---

### Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the Export section**

Replace the mock status notice with the real implementation details:

```markdown
### **6. Export (Server Side)**

* **Engine:** @remotion/renderer via `RenderService`.
* **Bundling:** `@remotion/bundler` bundles `client/src/remotion/index.ts` once (cached in memory).
* **Rendering:** `renderMedia()` with `selectComposition()` to set per-clip duration.
* **Hardware Acceleration:** `hardwareAcceleration: 'if-possible'`, `videoBitrate: '6000k'`, codec `h264`. On Apple Silicon this uses VideoToolbox automatically.
* **Delivery:** Server renders to `.lusk_temp/{sessionId}/output.mp4` and sets the download URL via orchestrator.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with real render implementation"
```

---

### Task 8: Manual integration test

**Step 1: Start the server**

Run: `cd server && npm run dev`

**Step 2: Start the client**

Run: `cd client && npm run dev`

**Step 3: Upload a video, transcribe, select a clip, adjust speaker offset, click Render**

Verify:
- Progress updates appear via SSE
- Output MP4 is created in `.lusk_temp/{sessionId}/output.mp4`
- Download link works
- Video has correct captions overlaid
- Video is cropped to 1080x1920
- Speaker offset is applied

**Step 4: Test render retry**

If render fails (e.g., no video file), verify the state returns to READY and user can retry.
