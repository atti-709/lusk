# Caption Styles & Outro in Clip Preview — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add adjustable caption styles (global, persisted) and move outro settings into the clip preview right panel as collapsible sections.

**Architecture:** Caption styles are stored in `~/.lusk/config.json` via `SettingsService`, exposed through `AppSettingsContext`, and passed as props through `VideoComposition` → `CaptionOverlay`. Outro upload/overlap controls move from `SettingsDialog` to `StudioView`. Both sections use a collapsible toggle pattern. The right panel becomes scrollable when expanded.

**Tech Stack:** React, TypeScript, Fastify, Remotion

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/types.ts` | Modify | Add `CaptionStyles` interface |
| `server/src/services/SettingsService.ts` | Modify | Add `captionStyles` to `AppSettings`, add getter with defaults |
| `server/src/routes/settings.ts` | Modify | Accept/return `captionStyles` in GET/PUT |
| `client/src/contexts/AppSettingsContext.tsx` | Modify | Add `captionStyles` + `updateCaptionStyles` to context |
| `client/src/components/CaptionOverlay.tsx` | Modify | Accept `CaptionStyles` props, replace hardcoded constants |
| `client/src/components/VideoComposition.tsx` | Modify | Accept + pass `CaptionStyles` to `CaptionOverlay` |
| `client/src/components/StudioView.tsx` | Modify | Add caption styles & outro collapsible sections, wire up state |
| `client/src/components/StudioView.css` | Modify | Scrollable panel, collapsible section styles, reduced textarea |
| `client/src/components/SettingsDialog.tsx` | Modify | Remove outro upload/overlap fields |
| `client/src/hooks/useOutroConfig.ts` | Modify | Add `reload()` method to hook return |
| `server/src/routes/render.ts` | Modify | Pass `captionStyles` to render inputProps |
| `server/src/services/RenderService.ts` | Modify | Accept + forward `captionStyles` in `renderClip` |

---

### Task 1: Add `CaptionStyles` type to shared types

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: Add the CaptionStyles interface**

Add after the `CaptionWord` interface:

```typescript
export interface CaptionStyles {
  fontSize: number;
  highlightColor: string;
  textColor: string;
  textTransform: "uppercase" | "none" | "capitalize";
  captionPosition: number;
  fontWeight: 800 | 900;
}

export const DEFAULT_CAPTION_STYLES: CaptionStyles = {
  fontSize: 56,
  highlightColor: "#F77205",
  textColor: "#ffffff",
  textTransform: "uppercase",
  captionPosition: 340,
  fontWeight: 900,
};
```

- [ ] **Step 2: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add CaptionStyles type and defaults to shared types"
```

---

### Task 2: Add `captionStyles` to server settings

**Files:**
- Modify: `server/src/services/SettingsService.ts`
- Modify: `server/src/routes/settings.ts`

- [ ] **Step 1: Update `AppSettings` interface in SettingsService.ts**

Add to the `AppSettings` interface:

```typescript
captionStyles?: {
  fontSize?: number;
  highlightColor?: string;
  textColor?: string;
  textTransform?: "uppercase" | "none" | "capitalize";
  captionPosition?: number;
  fontWeight?: 800 | 900;
};
```

Add a getter method to the `SettingsService` class:

```typescript
async getCaptionStyles(): Promise<AppSettings["captionStyles"]> {
  const settings = await this.load();
  return settings.captionStyles;
}
```

- [ ] **Step 2: Update settings route GET to return captionStyles**

In the `GET /api/settings` handler, add to the return object:

```typescript
captionStyles: settings.captionStyles ?? null,
```

- [ ] **Step 3: Update settings route PUT to accept captionStyles**

Add to the PUT body type:

```typescript
captionStyles?: {
  fontSize?: number;
  highlightColor?: string;
  textColor?: string;
  textTransform?: string;
  captionPosition?: number;
  fontWeight?: number;
} | null;
```

Add to the PUT handler body (after the `outroOverlapFrames` block):

```typescript
if (captionStyles !== undefined) {
  current.captionStyles = captionStyles ?? undefined;
}
```

Update the destructuring line to include `captionStyles`.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/SettingsService.ts server/src/routes/settings.ts
git commit -m "feat: add captionStyles to server settings API"
```

---

### Task 3: Add `captionStyles` to `AppSettingsContext`

**Files:**
- Modify: `client/src/contexts/AppSettingsContext.tsx`

- [ ] **Step 1: Import `CaptionStyles` and `DEFAULT_CAPTION_STYLES`, extend the context**

```typescript
import type { CaptionStyles } from "@lusk/shared";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";
```

Add to `AppSettingsCtx`:

```typescript
interface AppSettingsCtx {
  fps: number;
  outroOverlapFrames: number;
  outroSet: boolean;
  loading: boolean;
  captionStyles: CaptionStyles;
  reload: () => void;
  updateCaptionStyles: (styles: CaptionStyles) => void;
}
```

Default context value gets `captionStyles: DEFAULT_CAPTION_STYLES` and `updateCaptionStyles: () => {}`.

- [ ] **Step 2: Add state and update function in the provider**

```typescript
const [captionStyles, setCaptionStyles] = useState<CaptionStyles>(DEFAULT_CAPTION_STYLES);
```

In the `load` callback, after setting other state:

```typescript
const serverStyles = data.captionStyles;
if (serverStyles) {
  setCaptionStyles({ ...DEFAULT_CAPTION_STYLES, ...serverStyles });
}
```

Add the update function:

```typescript
const updateCaptionStyles = useCallback(async (styles: CaptionStyles) => {
  setCaptionStyles(styles);
  await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ captionStyles: styles }),
  });
}, []);
```

Pass `captionStyles` and `updateCaptionStyles` into the Provider value.

- [ ] **Step 3: Commit**

```bash
git add client/src/contexts/AppSettingsContext.tsx
git commit -m "feat: add captionStyles to AppSettingsContext with server persistence"
```

---

### Task 4: Update `CaptionOverlay` to accept style props

**Files:**
- Modify: `client/src/components/CaptionOverlay.tsx`

- [ ] **Step 1: Change `CaptionOverlayProps` to include styles**

Import the type:

```typescript
import type { CaptionStyles } from "@lusk/shared";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";
```

Update the props type:

```typescript
export type CaptionOverlayProps = {
  captions: Caption[];
  captionStyles?: CaptionStyles;
};
```

- [ ] **Step 2: Update `CaptionPage` to accept and use styles**

Change `CaptionPage` signature:

```typescript
function CaptionPage({ page, styles }: { page: TikTokPage; styles: CaptionStyles }) {
```

Replace hardcoded values in the JSX:
- `paddingBottom: 340` → `paddingBottom: styles.captionPosition`
- `fontSize: 56` → `fontSize: styles.fontSize`
- `fontWeight: 900` → `fontWeight: styles.fontWeight`
- `textTransform: "uppercase"` → `textTransform: styles.textTransform`
- `color: isActive ? HIGHLIGHT_COLOR : TEXT_COLOR` → `color: isActive ? styles.highlightColor : styles.textColor`

Keep `SHADOW`, `fontFamily`, `letterSpacing`, `lineHeight`, `maxWidth`, `whiteSpace`, and the animation `transform`/`transition` unchanged.

Remove the now-unused constants `HIGHLIGHT_COLOR` and `TEXT_COLOR`. Keep `SWITCH_CAPTIONS_EVERY_MS` and `SHADOW`.

- [ ] **Step 3: Update `CaptionOverlay` to pass styles to `CaptionPage`**

```typescript
export function CaptionOverlay({ captions, captionStyles }: CaptionOverlayProps) {
  const styles = captionStyles ?? DEFAULT_CAPTION_STYLES;
  // ...
  <CaptionPage page={page} styles={styles} />
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/CaptionOverlay.tsx
git commit -m "feat: make CaptionOverlay accept style props instead of hardcoded values"
```

---

### Task 5: Thread `captionStyles` through `VideoComposition`

**Files:**
- Modify: `client/src/components/VideoComposition.tsx`

- [ ] **Step 1: Add `captionStyles` to `VideoCompositionProps`**

```typescript
import type { CaptionStyles } from "@lusk/shared";

export type VideoCompositionProps = {
  videoUrl: string;
  captions: Caption[];
  offsetX: number;
  startFrom?: number;
  outroSrc?: string;
  outroDurationInFrames?: number;
  outroOverlapFrames?: number;
  sourceAspectRatio?: number | null;
  captionStyles?: CaptionStyles;
};
```

- [ ] **Step 2: Pass to CaptionOverlay**

In `VideoComposition`, destructure `captionStyles` and pass it:

```typescript
{captions.length > 0 && <CaptionOverlay captions={captions} captionStyles={captionStyles} />}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/VideoComposition.tsx
git commit -m "feat: thread captionStyles through VideoComposition to CaptionOverlay"
```

---

### Task 6: Make `useOutroConfig` reloadable

**Files:**
- Modify: `client/src/hooks/useOutroConfig.ts`

- [ ] **Step 1: Add reload trigger**

Change the hook to return an object with `config` and `reload`:

```typescript
export function useOutroConfig(): { config: OutroConfig | null; reload: () => void } {
  const [config, setConfig] = useState<OutroConfig | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    fetch("/api/outro-config")
      .then((r) => r.json())
      .then((data: OutroConfig) => {
        if (data.outroSrc) setConfig(data);
        else setConfig(null);
      })
      .catch(() => {});
  }, [trigger]);

  const reload = useCallback(() => setTrigger((t) => t + 1), []);

  return { config, reload };
}
```

- [ ] **Step 2: Update StudioView usage**

Change from:

```typescript
const outroConfig = useOutroConfig();
```

To:

```typescript
const { config: outroConfig, reload: reloadOutro } = useOutroConfig();
```

All existing references to `outroConfig` remain unchanged (it's still `OutroConfig | null`).

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/useOutroConfig.ts client/src/components/StudioView.tsx
git commit -m "feat: add reload capability to useOutroConfig hook"
```

---

### Task 7: Add collapsible sections and caption styles UI to StudioView

**Files:**
- Modify: `client/src/components/StudioView.tsx`
- Modify: `client/src/components/StudioView.css`

This is the main UI task. It adds two collapsible sections to the right panel.

- [ ] **Step 1: Add CSS for collapsible sections and scrollable panel**

Add to `StudioView.css`:

```css
/* Make the right panel scrollable and match player height */
.studio-right {
  overflow-y: auto;
  max-height: calc((360px / 1080) * 1920); /* match 9:16 aspect of max player width */
}

/* Reduce caption textarea flex growth */
.studio-right > .control-group:first-child {
  flex: unset;
  min-height: unset;
}

.caption-editor {
  flex: unset;
  height: auto;
}

/* Collapsible section */
.collapsible-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  padding: 0.5rem 0;
}

.collapsible-header .control-label {
  cursor: pointer;
  gap: 0.4rem;
}

.collapsible-chevron {
  width: 14px;
  height: 14px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.collapsible-chevron.open {
  transform: rotate(90deg);
}

.collapsible-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-top: 0.25rem;
}

/* Caption style controls */
.style-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.style-row label {
  font-size: 0.75rem;
  color: var(--text-muted);
  min-width: 70px;
  flex-shrink: 0;
}

.style-row input[type="color"] {
  -webkit-appearance: none;
  appearance: none;
  width: 32px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  padding: 0;
}

.style-row input[type="color"]::-webkit-color-swatch-wrapper {
  padding: 2px;
}

.style-row input[type="color"]::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}

.style-row select {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 0.8rem;
  padding: 0.3rem 0.5rem;
}

.style-row .offset-slider {
  flex: 1;
}

.style-row .control-value {
  font-size: 0.75rem;
  min-width: 35px;
  text-align: right;
}

/* Outro controls in studio */
.outro-status {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.outro-status.active {
  color: var(--success);
}

.outro-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.outro-actions input[type="file"] {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.outro-actions button {
  font-size: 0.75rem;
  padding: 0.3em 0.8em;
}

.collapsible-reset-btn {
  background: none;
  border: none;
  padding: 0.25rem;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  opacity: 0.7;
}

.collapsible-reset-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
  opacity: 1;
}
```

- [ ] **Step 2: Import caption styles from context and add state for collapsible sections**

In `StudioView.tsx`, add imports:

```typescript
import { useAppSettings } from "../contexts/AppSettingsContext";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";
import type { CaptionStyles } from "@lusk/shared";
```

Inside the component, add:

```typescript
const { fps, captionStyles, updateCaptionStyles } = useAppSettings();
const [stylesOpen, setStylesOpen] = useState(false);
const [outroOpen, setOutroOpen] = useState(false);
```

- [ ] **Step 3: Add outro upload/delete handlers**

```typescript
const [outroUploading, setOutroUploading] = useState(false);

const handleOutroUpload = useCallback(async (file: File) => {
  setOutroUploading(true);
  const formData = new FormData();
  formData.append("outro", file);
  try {
    const res = await fetch("/api/settings/outro", { method: "POST", body: formData });
    if (res.ok) reloadOutro();
  } catch { /* ignore */ }
  finally { setOutroUploading(false); }
}, [reloadOutro]);

const handleOutroDelete = useCallback(async () => {
  try {
    const res = await fetch("/api/settings/outro", { method: "DELETE" });
    if (res.ok) reloadOutro();
  } catch { /* ignore */ }
}, [reloadOutro]);

const handleOverlapChange = useCallback(async (val: number) => {
  // Update server, then reload outro config to get the new value reflected
  await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outroOverlapFrames: val }),
  });
  reloadOutro();
}, [reloadOutro]);
```

- [ ] **Step 4: Add caption styles update helper**

```typescript
const handleStyleChange = useCallback(<K extends keyof CaptionStyles>(key: K, value: CaptionStyles[K]) => {
  const updated = { ...captionStyles, [key]: value };
  updateCaptionStyles(updated);
}, [captionStyles, updateCaptionStyles]);

const handleResetStyles = useCallback(() => {
  updateCaptionStyles(DEFAULT_CAPTION_STYLES);
}, [updateCaptionStyles]);

const isStylesModified = JSON.stringify(captionStyles) !== JSON.stringify(DEFAULT_CAPTION_STYLES);
```

- [ ] **Step 5: Pass `captionStyles` to the Player inputProps**

In the `<Player>` `inputProps`, add:

```typescript
captionStyles,
```

- [ ] **Step 6: Add the Caption Styles collapsible section JSX**

Place this after the Captions textarea control-group, before the Trim Start control:

```tsx
{/* Caption Styles */}
<div className="control-group">
  <div className="collapsible-header" onClick={() => setStylesOpen(!stylesOpen)}>
    <span className="control-label">
      <svg className={`collapsible-chevron${stylesOpen ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
      Caption Styles
    </span>
    {isStylesModified && (
      <button className="collapsible-reset-btn" onClick={(e) => { e.stopPropagation(); handleResetStyles(); }} title="Reset to defaults">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 2v6h6" />
          <path d="M2.66 15.57a10 10 0 1 0 .57-8.38" />
        </svg>
      </button>
    )}
  </div>
  {stylesOpen && (
    <div className="collapsible-body">
      <div className="style-row">
        <label>Size</label>
        <input type="range" className="offset-slider" min={32} max={80} step={1} value={captionStyles.fontSize} onChange={(e) => handleStyleChange("fontSize", Number(e.target.value))} />
        <span className="control-value">{captionStyles.fontSize}</span>
      </div>
      <div className="style-row">
        <label>Highlight</label>
        <input type="color" value={captionStyles.highlightColor} onChange={(e) => handleStyleChange("highlightColor", e.target.value)} />
      </div>
      <div className="style-row">
        <label>Text color</label>
        <input type="color" value={captionStyles.textColor} onChange={(e) => handleStyleChange("textColor", e.target.value)} />
      </div>
      <div className="style-row">
        <label>Transform</label>
        <select value={captionStyles.textTransform} onChange={(e) => handleStyleChange("textTransform", e.target.value as CaptionStyles["textTransform"])}>
          <option value="uppercase">UPPERCASE</option>
          <option value="none">None</option>
          <option value="capitalize">Capitalize</option>
        </select>
      </div>
      <div className="style-row">
        <label>Weight</label>
        <select value={captionStyles.fontWeight} onChange={(e) => handleStyleChange("fontWeight", Number(e.target.value) as 800 | 900)}>
          <option value={900}>900 (Bold)</option>
          <option value={800}>800 (Heavy)</option>
        </select>
      </div>
      <div className="style-row">
        <label>Position</label>
        <input type="range" className="offset-slider" min={100} max={600} step={10} value={captionStyles.captionPosition} onChange={(e) => handleStyleChange("captionPosition", Number(e.target.value))} />
        <span className="control-value">{captionStyles.captionPosition}</span>
      </div>
    </div>
  )}
</div>
```

- [ ] **Step 7: Add the Outro collapsible section JSX**

Place this after the Caption Sync control, before the Render progress section:

```tsx
{/* Outro */}
<div className="control-group">
  <div className="collapsible-header" onClick={() => setOutroOpen(!outroOpen)}>
    <span className="control-label">
      <svg className={`collapsible-chevron${outroOpen ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
      Outro
      {outroConfig && <span style={{ fontSize: "0.7rem", color: "var(--success)", marginLeft: "0.5rem" }}>Active</span>}
    </span>
  </div>
  {outroOpen && (
    <div className="collapsible-body">
      <div className="outro-actions">
        <input
          type="file"
          accept="video/mp4"
          disabled={outroUploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleOutroUpload(file);
            e.target.value = "";
          }}
        />
        {outroConfig && (
          <button className="secondary" onClick={handleOutroDelete}>Remove</button>
        )}
      </div>
      {outroConfig && (
        <div className="style-row">
          <label>Overlap</label>
          <input type="range" className="offset-slider" min={0} max={30} step={1} value={outroConfig.outroOverlapFrames} onChange={(e) => handleOverlapChange(Number(e.target.value))} />
          <span className="control-value">{outroConfig.outroOverlapFrames}f</span>
        </div>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 8: Commit**

```bash
git add client/src/components/StudioView.tsx client/src/components/StudioView.css
git commit -m "feat: add caption styles and outro collapsible sections to clip preview"
```

---

### Task 8: Remove outro settings from SettingsDialog

**Files:**
- Modify: `client/src/components/SettingsDialog.tsx`

- [ ] **Step 1: Remove outro-related fields**

Remove from the component:
- The `outroOverlapFrames` state and its setter
- The `outroSet` state and its setter
- The `handleOutroUpload` callback
- The `handleOutroDelete` callback
- The outro status/upload/delete JSX block (`<div className="settings-field">` with `<label>Outro</label>`)
- The outro overlap frames JSX block (`<div className="settings-field">` with `Outro Overlap Frames`)
- Remove `outroOverlapFrames` from the `handleSave` body object
- Remove `outroOverlapFrames` from the `useEffect` settings load (the line `setOutroOverlapFrames(...)`)
- Remove `outroSet` from the `useEffect` settings load
- Remove `outroOverlapFrames` from the `handleSave` dependency array

- [ ] **Step 2: Commit**

```bash
git add client/src/components/SettingsDialog.tsx
git commit -m "refactor: remove outro settings from SettingsDialog (moved to clip preview)"
```

---

### Task 9: Pass `captionStyles` through server-side rendering

**Files:**
- Modify: `server/src/services/RenderService.ts`
- Modify: `server/src/routes/render.ts`

The rendered video needs to use the same caption styles as the preview.

- [ ] **Step 1: Update RenderService.renderClip to load and pass captionStyles**

In `RenderService.renderClip`, after loading `outroOverlapFrames`, add:

```typescript
const captionStyles = await settingsService.getCaptionStyles();
```

Add `captionStyles` to the `inputProps` object:

```typescript
const inputProps = {
  videoUrl,
  captions: remotionCaptions,
  offsetX,
  startFrom: startFrame,
  outroSrc: hasOutro ? outroConfig.outroSrc : "",
  outroDurationInFrames,
  outroOverlapFrames,
  sourceAspectRatio: sourceAspectRatio ?? null,
  captionStyles: captionStyles ?? undefined,
};
```

No changes needed to `render.ts` — the styles come from the server config, not the request body.

- [ ] **Step 2: Commit**

```bash
git add server/src/services/RenderService.ts
git commit -m "feat: pass captionStyles through server-side rendering pipeline"
```

---

### Task 10: Verify and test

- [ ] **Step 1: Run dev server**

```bash
cd /Users/atti/Source/Repos/lusk && npm run dev
```

- [ ] **Step 2: Verify the following manually**

1. Open a project, go to clip preview
2. Right panel should show captions textarea (4 rows), collapsed "Caption Styles" section, trim controls, speaker position, caption sync, collapsed "Outro" section, render button
3. Expand Caption Styles — adjust font size slider, color pickers, transform select, weight select, position slider — preview updates live
4. Reset button appears when styles differ from defaults; clicking it reverts all
5. Expand Outro — upload/remove outro, adjust overlap — preview updates
6. Scroll the right panel when both sections are expanded
7. Close and reopen the app — styles persist (global)
8. Render a clip — rendered video uses the custom caption styles
9. Settings dialog no longer has outro fields

- [ ] **Step 3: Commit any fixes**
