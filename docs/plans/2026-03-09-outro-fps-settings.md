# Outro Upload, Overlap Frames & FPS Settings

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make outro video, overlap frames, and FPS configurable via the global settings UI.

**Architecture:** Extend the existing `AppSettings` config with `outroOverlapFrames` and `fps` fields. Store the user-uploaded outro in `~/.lusk/outro.mp4`. Create an `AppSettingsContext` on the client to propagate FPS/overlap to all components that currently import the hardcoded constants. The server reads these values from `SettingsService` at render time.

**Tech Stack:** React Context, Fastify multipart upload, existing SettingsService pattern.

---

### Task 1: Add new fields to AppSettings and SettingsService

**Files:**
- Modify: `server/src/services/SettingsService.ts`

**Step 1: Add fields to interface and getters**

Add `fps` and `outroOverlapFrames` to `AppSettings`. Add getter methods with defaults.

```typescript
// In AppSettings interface, add:
  fps?: number;
  outroOverlapFrames?: number;

// Add getters:
  async getFps(): Promise<number> {
    const settings = await this.load();
    return settings.fps ?? 23.976;
  }

  async getOutroOverlapFrames(): Promise<number> {
    const settings = await this.load();
    return settings.outroOverlapFrames ?? 4;
  }
```

Also extract a `getConfigDir()` helper (reuse the existing `getConfigPath` pattern) since we'll need it for outro file storage:

```typescript
export function getConfigDir(): string {
  return process.env.LUSK_REGISTRY_DIR ?? join(homedir(), ".lusk");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}
```

**Step 2: Commit**

```
feat: add fps and outroOverlapFrames to AppSettings
```

---

### Task 2: Update settings route — expose new fields + outro upload

**Files:**
- Modify: `server/src/routes/settings.ts`

**Step 1: Update GET and PUT for new fields**

`GET /api/settings` returns `fps` and `outroOverlapFrames` (with defaults).
`PUT /api/settings` accepts them. Validate `fps` against allowed values `[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]`. Validate `outroOverlapFrames` is an integer 0–30.

```typescript
// In GET handler, add to return:
fps: settings.fps ?? 23.976,
outroOverlapFrames: settings.outroOverlapFrames ?? 4,

// In PUT handler, add:
const ALLOWED_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
if (body.fps !== undefined && ALLOWED_FPS.includes(body.fps)) {
  current.fps = body.fps;
}
if (body.outroOverlapFrames !== undefined) {
  const v = Math.round(body.outroOverlapFrames);
  if (v >= 0 && v <= 30) current.outroOverlapFrames = v;
}
```

**Step 2: Add outro upload + delete endpoints**

```typescript
// POST /api/settings/outro — multipart file upload
// Saves uploaded file to ~/.lusk/outro.mp4
// Returns { success: true }

// DELETE /api/settings/outro — removes ~/.lusk/outro.mp4
// Returns { success: true }
```

Register `@fastify/multipart` for the upload endpoint. Save to `getConfigDir() + "/outro.mp4"`.

**Step 3: Commit**

```
feat: settings route handles fps, overlap, and outro upload
```

---

### Task 3: Serve the global outro file and update detectOutroConfig

**Files:**
- Modify: `server/src/plugins/static.ts`
- Modify: `server/src/services/RenderService.ts`

**Step 1: Add static route for config dir assets**

In `static.ts`, register a new static prefix `/config-assets/` pointing to `getConfigDir()` so the uploaded outro is accessible via HTTP at `/config-assets/outro.mp4`.

```typescript
import { getConfigDir } from "../services/SettingsService.js";

const configDir = getConfigDir();
await app.register(fastifyStatic, {
  root: configDir,
  prefix: "/config-assets/",
  decorateReply: false,
});
```

**Step 2: Update RenderService to check global outro first**

`detectOutroConfig()` should:
1. Check `~/.lusk/outro.mp4` first (global config dir)
2. Fall back to `client/public/outro.mp4` (bundled default)
3. Read `fps` and `outroOverlapFrames` from settings

Remove the hardcoded `COMP_FPS` and `OUTRO_OVERLAP_FRAMES` constants from RenderService. Instead, read them from `settingsService` at render time.

```typescript
async detectOutroConfig(): Promise<OutroConfig | null> {
  const configDir = getConfigDir();
  const globalOutro = path.join(configDir, "outro.mp4");
  const bundledOutro = path.join(this.publicDir, "outro.mp4");

  const outroPath = fs.existsSync(globalOutro) ? globalOutro :
                    fs.existsSync(bundledOutro) ? bundledOutro : null;
  if (!outroPath) return null;

  const outroDuration = await this.probeDuration(outroPath);
  if (outroDuration <= 0) return null;

  const fps = await settingsService.getFps();
  const isGlobal = outroPath === globalOutro;

  return {
    outroSrc: isGlobal
      ? `${LUSK_SERVER_ORIGIN}/config-assets/outro.mp4`
      : `${LUSK_SERVER_ORIGIN}/public/outro.mp4`,
    outroDurationInFrames: Math.ceil(outroDuration * fps),
  };
}
```

Update `renderClip()`:
- Read `fps` from `settingsService.getFps()` instead of hardcoded `COMP_FPS`
- Read `outroOverlapFrames` from `settingsService.getOutroOverlapFrames()` instead of hardcoded constant

**Step 3: Commit**

```
feat: serve global outro, use settings for fps/overlap in RenderService
```

---

### Task 4: Add outro status to GET /api/outro-config

**Files:**
- Modify: `server/src/routes/render.ts`

**Step 1: Include overlap frames in outro-config response**

The `/api/outro-config` endpoint should also return `outroOverlapFrames` so the client can use the configured value for preview.

```typescript
app.get("/api/outro-config", async () => {
  const config = await renderService.detectOutroConfig();
  const outroOverlapFrames = await settingsService.getOutroOverlapFrames();
  return config
    ? { ...config, outroOverlapFrames }
    : { outroSrc: "", outroDurationInFrames: 0, outroOverlapFrames };
});
```

**Step 2: Update `OutroConfig` interface** (both server and client copies)

Add `outroOverlapFrames: number` to `OutroConfig` in:
- `server/src/services/RenderService.ts`
- `client/src/hooks/useOutroConfig.ts`

**Step 3: Commit**

```
feat: include outroOverlapFrames in outro-config API response
```

---

### Task 5: Create AppSettingsContext on the client

**Files:**
- Create: `client/src/contexts/AppSettingsContext.tsx`

**Step 1: Create the context**

```typescript
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface AppSettingsCtx {
  fps: number;
  outroOverlapFrames: number;
  outroSet: boolean;
  loading: boolean;
  reload: () => void;
}

const AppSettingsContext = createContext<AppSettingsCtx>({
  fps: 23.976,
  outroOverlapFrames: 4,
  outroSet: false,
  loading: true,
  reload: () => {},
});

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [fps, setFps] = useState(23.976);
  const [outroOverlapFrames, setOutroOverlapFrames] = useState(4);
  const [outroSet, setOutroSet] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = () => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setFps(data.fps ?? 23.976);
        setOutroOverlapFrames(data.outroOverlapFrames ?? 4);
        setOutroSet(data.outroSet ?? false);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <AppSettingsContext.Provider value={{ fps, outroOverlapFrames, outroSet, loading, reload: load }}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  return useContext(AppSettingsContext);
}
```

**Step 2: Wrap the app**

In `client/src/main.tsx` (or wherever the root render is), wrap with `<AppSettingsProvider>`.

**Step 3: Commit**

```
feat: add AppSettingsContext for fps and outro config
```

---

### Task 6: Replace hardcoded COMP_FPS imports with context

**Files:**
- Modify: `client/src/components/StudioView.tsx`
- Modify: `client/src/components/PipelineStepper.tsx`
- Modify: `client/src/components/ClipSelector.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/VideoComposition.tsx`
- Modify: `client/src/remotion/Root.tsx`

**Step 1: Keep `COMP_FPS` as default in VideoComposition.tsx**

`COMP_FPS` stays as the **default/fallback** constant and for Remotion Studio (`Root.tsx`). It is still exported for use in Root.tsx (studio preview only).

**Step 2: Update StudioView.tsx**

Replace all `COMP_FPS` usage with `fps` from `useAppSettings()`. Replace `OUTRO_OVERLAP_FRAMES` with `outroConfig?.outroOverlapFrames ?? 4`.

Key changes:
- `const { fps } = useAppSettings();`
- `const startFrame = Math.round((effectiveStartMs / 1000) * fps);`
- `const actualStartMs = (startFrame / fps) * 1000;`
- `const clipDurationInFrames = Math.max(1, Math.ceil(((effectiveEndMs - actualStartMs) / 1000) * fps));`
- `const overlap = outroDurationInFrames > 0 ? (outroConfig?.outroOverlapFrames ?? 4) : 0;`
- `const totalDurationSec = (durationInFrames / fps).toFixed(1);`
- `fps={fps}` on the Player component

Remove `COMP_FPS` and `OUTRO_OVERLAP_FRAMES` from the import.

**Step 3: Update PipelineStepper.tsx**

Replace `COMP_FPS` with `fps` from `useAppSettings()`.

**Step 4: Update App.tsx**

Replace `COMP_FPS` with `fps` from `useAppSettings()`.

**Step 5: Update ClipSelector.tsx**

Replace `COMP_FPS_BATCH` with `fps` from `useAppSettings()`. Remove the hardcoded constant.

**Step 6: Commit**

```
feat: use AppSettingsContext for fps across all client components
```

---

### Task 7: Update useOutroConfig to include overlap frames

**Files:**
- Modify: `client/src/hooks/useOutroConfig.ts`

**Step 1: Update the interface and hook**

```typescript
export interface OutroConfig {
  outroSrc: string;
  outroDurationInFrames: number;
  outroOverlapFrames: number;
}
```

The hook already fetches from `/api/outro-config` which now returns `outroOverlapFrames` (from Task 4).

**Step 2: Commit**

```
feat: useOutroConfig returns outroOverlapFrames
```

---

### Task 8: Add outro upload + FPS + overlap UI to SettingsDialog

**Files:**
- Modify: `client/src/components/SettingsDialog.tsx`
- Modify: `client/src/App.css`

**Step 1: Add FPS selector**

Add a `<select>` dropdown with standard frame rates:

```typescript
const FPS_OPTIONS = [
  { value: 23.976, label: "23.976 (Film)" },
  { value: 24, label: "24" },
  { value: 25, label: "25 (PAL)" },
  { value: 29.97, label: "29.97 (NTSC)" },
  { value: 30, label: "30" },
  { value: 50, label: "50" },
  { value: 59.94, label: "59.94" },
  { value: 60, label: "60" },
];
```

**Step 2: Add overlap frames input**

Number input, min 0, max 30, step 1. Label: "Outro Overlap Frames".

**Step 3: Add outro file upload**

- File input accepting `video/mp4`
- Show current status: "Outro set" / "No outro configured"
- Upload button posts to `POST /api/settings/outro`
- Delete button calls `DELETE /api/settings/outro`
- After upload/delete, call `appSettings.reload()` from context

**Step 4: Wire save to include new fields**

Include `fps` and `outroOverlapFrames` in the PUT body. After save, call `appSettings.reload()` so context updates everywhere.

**Step 5: Add CSS for new controls**

Style the file upload area and status indicator.

**Step 6: Commit**

```
feat: settings UI for outro upload, FPS, and overlap frames
```

---

### Task 9: Also expose outro status in GET /api/settings

**Files:**
- Modify: `server/src/routes/settings.ts`

**Step 1: Add outroSet boolean**

Check if `~/.lusk/outro.mp4` or `client/public/outro.mp4` exists, return `outroSet: true/false` in GET response. This lets the settings dialog and context know whether an outro is configured without calling the separate outro-config endpoint.

```typescript
import fs from "node:fs";
import { join } from "node:path";

// In GET handler:
const configDir = getConfigDir();
const outroSet = fs.existsSync(join(configDir, "outro.mp4")) ||
                 fs.existsSync(join(getClientPublicDir(), "outro.mp4"));
// Add to return: outroSet,
```

**Step 2: Invalidate RenderService bundle cache after outro upload/delete**

After uploading or deleting the outro, call `renderService.invalidateBundle()` so the next render picks up the change.

**Step 3: Commit**

```
feat: expose outroSet in settings, invalidate bundle on outro change
```

---

### Task 10: Install @fastify/multipart

**Files:**
- Modify: `server/package.json`

**Step 1: Install dependency**

```bash
npm install @fastify/multipart -w server
```

**Step 2: Commit**

```
chore: add @fastify/multipart for outro file upload
```

**Note:** This task should be done early (before Task 2) since the upload endpoint depends on it.

---

## Execution Order

The recommended order considering dependencies:

1. **Task 10** (install multipart) — no deps
2. **Task 1** (AppSettings + SettingsService) — no deps
3. **Task 2** (settings route) — depends on 1, 10
4. **Task 3** (static serving + RenderService) — depends on 1
5. **Task 4** (outro-config API) — depends on 3
6. **Task 7** (useOutroConfig hook) — depends on 4
7. **Task 5** (AppSettingsContext) — depends on 2
8. **Task 6** (replace COMP_FPS everywhere) — depends on 5, 7
9. **Task 9** (outroSet in settings, bundle invalidation) — depends on 2, 3
10. **Task 8** (settings UI) — depends on 2, 5, 9
