# Font Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a font family selector to the caption styles panel, letting users choose from 8 curated Google Fonts with auto-adapting weight options.

**Architecture:** Add `fontFamily` to the shared `CaptionStyles` type, build a font registry in `CaptionOverlay.tsx` that maps font keys to their Remotion loaders and available weights, add a font dropdown to `StudioView.tsx` that auto-updates the weight dropdown when the font changes.

**Tech Stack:** @remotion/google-fonts, React, TypeScript

---

### Task 1: Update CaptionStyles type in shared/types.ts

**Files:**
- Modify: `shared/types.ts:74-90`

- [ ] **Step 1: Add fontFamily to CaptionStyles interface and widen fontWeight**

In `shared/types.ts`, update the interface and default:

```typescript
export interface CaptionStyles {
  fontSize: number;
  fontFamily: string;
  highlightColor: string;
  textColor: string;
  textTransform: "uppercase" | "none" | "capitalize";
  captionPosition: number;
  fontWeight: number;
}

export const DEFAULT_CAPTION_STYLES: CaptionStyles = {
  fontSize: 56,
  fontFamily: "Montserrat",
  highlightColor: "#F77205",
  textColor: "#ffffff",
  textTransform: "uppercase",
  captionPosition: 340,
  fontWeight: 900,
};
```

Key changes:
- Added `fontFamily: string` field
- Changed `fontWeight` from `800 | 900` to `number`
- Default `fontFamily` is `"Montserrat"` for backward compat

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p shared/tsconfig.json`

If there's no shared tsconfig, run: `npx tsc --noEmit -p client/tsconfig.json` to check for type errors rippling through.

Expected: Type errors in `StudioView.tsx` at the weight dropdown cast `as 800 | 900` — this is expected and fixed in Task 3.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add fontFamily to CaptionStyles and widen fontWeight type"
```

---

### Task 2: Build font registry and dynamic loading in CaptionOverlay.tsx

**Files:**
- Modify: `client/src/components/CaptionOverlay.tsx:1-17`

- [ ] **Step 1: Replace hardcoded Montserrat with font registry**

Replace lines 1-17 of `CaptionOverlay.tsx` with:

```typescript
import { useMemo } from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { createTikTokStyleCaptions } from "@remotion/captions";
import type { TikTokPage, Caption } from "@remotion/captions";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadBangers } from "@remotion/google-fonts/Bangers";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import type { CaptionStyles } from "@lusk/shared";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";

type FontEntry = {
  load: typeof loadMontserrat;
  weights: number[];
};

export const FONT_REGISTRY: Record<string, FontEntry> = {
  Montserrat:      { load: loadMontserrat,    weights: [400, 500, 600, 700, 800, 900] },
  Inter:           { load: loadInter,          weights: [400, 500, 600, 700, 800, 900] },
  Oswald:          { load: loadOswald,         weights: [400, 500, 600, 700] },
  "Bebas Neue":    { load: loadBebasNeue,      weights: [400] },
  Poppins:         { load: loadPoppins,        weights: [400, 500, 600, 700, 800, 900] },
  Bangers:         { load: loadBangers,        weights: [400] },
  "Space Mono":    { load: loadSpaceMono,      weights: [400, 700] },
  "Space Grotesk": { load: loadSpaceGrotesk,   weights: [400, 500, 600, 700] },
};

function useFontFamily(fontKey: string): string {
  return useMemo(() => {
    const entry = FONT_REGISTRY[fontKey] ?? FONT_REGISTRY["Montserrat"];
    const { fontFamily } = entry.load("normal", {
      weights: entry.weights.map(String) as ("400" | "500" | "600" | "700" | "800" | "900")[],
      subsets: ["latin", "latin-ext"],
    });
    return fontFamily;
  }, [fontKey]);
}
```

- [ ] **Step 2: Update CaptionPage to use dynamic font**

Replace the `fontFamily` reference on line 46 (inside CaptionPage's style object). Change the `CaptionPage` function signature and body:

```typescript
function CaptionPage({ page, styles, fontFamily }: { page: TikTokPage; styles: CaptionStyles; fontFamily: string }) {
```

The `fontFamily` in the style object on line 46 already refers to the prop now — no other change needed in the JSX.

- [ ] **Step 3: Update CaptionOverlay to load font and pass it down**

In the `CaptionOverlay` component, add the font loading hook and pass `fontFamily` to `CaptionPage`:

```typescript
export function CaptionOverlay({ captions, captionStyles }: CaptionOverlayProps) {
  const styles = captionStyles ?? DEFAULT_CAPTION_STYLES;
  const fontFamily = useFontFamily(styles.fontFamily);
  const { fps } = useVideoConfig();
```

And in the JSX where `CaptionPage` is rendered, add the `fontFamily` prop:

```typescript
            <CaptionPage page={page} styles={styles} fontFamily={fontFamily} />
```

- [ ] **Step 4: Verify the client compiles**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p client/tsconfig.json`

Expected: May still have the `as 800 | 900` error in StudioView — that's fixed in Task 3.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/CaptionOverlay.tsx
git commit -m "feat: add font registry with 8 Google Fonts and dynamic loading"
```

---

### Task 3: Add font selector dropdown and auto-adapt weights in StudioView.tsx

**Files:**
- Modify: `client/src/components/StudioView.tsx:4,414-442`

- [ ] **Step 1: Import FONT_REGISTRY**

Add to the imports at the top of `StudioView.tsx` (after the existing imports around line 10):

```typescript
import { FONT_REGISTRY } from "./CaptionOverlay";
```

- [ ] **Step 2: Add font dropdown above the Size slider**

In the `{stylesOpen && (` block (line 414), add the font dropdown as the first `style-row` inside `collapsible-body`, before the Size row:

```typescript
              <div className="collapsible-body">
                <div className="style-row">
                  <label>Font</label>
                  <select value={captionStyles.fontFamily ?? "Montserrat"} onChange={(e) => {
                    const newFont = e.target.value;
                    const entry = FONT_REGISTRY[newFont];
                    const availableWeights = entry?.weights ?? [900];
                    // Snap weight to nearest available if current weight isn't supported
                    const currentWeight = captionStyles.fontWeight;
                    const newWeight = availableWeights.includes(currentWeight)
                      ? currentWeight
                      : availableWeights.reduce((best, w) => Math.abs(w - currentWeight) < Math.abs(best - currentWeight) ? w : best);
                    handleStyleChange("fontFamily", newFont);
                    if (newWeight !== currentWeight) {
                      handleStyleChange("fontWeight", newWeight);
                    }
                  }}>
                    {Object.keys(FONT_REGISTRY).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>
                <div className="style-row">
                  <label>Size</label>
```

- [ ] **Step 3: Update the Weight dropdown to show per-font weights**

Replace the existing Weight style-row (currently lines 436-442) with:

```typescript
                <div className="style-row">
                  <label>Weight</label>
                  <select value={captionStyles.fontWeight} onChange={(e) => handleStyleChange("fontWeight", Number(e.target.value))}>
                    {(FONT_REGISTRY[captionStyles.fontFamily ?? "Montserrat"]?.weights ?? [900]).map((w) => (
                      <option key={w} value={w}>{w}</option>
                    ))}
                  </select>
                </div>
```

This removes the `as 800 | 900` cast that would now be a type error.

- [ ] **Step 4: Verify everything compiles**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p client/tsconfig.json`

Expected: No errors.

- [ ] **Step 5: Manual smoke test**

Run: `cd /Users/atti/Source/Repos/lusk && npm run dev`

Test in browser:
1. Open a project with captions
2. Expand "Caption Styles"
3. Verify "Font" dropdown appears with all 8 fonts
4. Select "Space Mono" — captions should change to monospace, weight dropdown should show 400 and 700
5. Select "Bebas Neue" — weight dropdown should show only 400
6. Select "Montserrat" — weight dropdown should show 400-900, weight should restore or snap to nearest

- [ ] **Step 6: Commit**

```bash
git add client/src/components/StudioView.tsx
git commit -m "feat: add font selector dropdown with auto-adapting weight options"
```

---

### Task 4: Update settings API schema for fontFamily

**Files:**
- Modify: `server/src/routes/settings.ts`

- [ ] **Step 1: Add fontFamily to the PUT schema**

In `server/src/routes/settings.ts`, find the `captionStyles` schema in the PUT route body (around line 49-105) and add `fontFamily` and widen `fontWeight`:

Add to the captionStyles properties:
```typescript
fontFamily: { type: "string" },
```

And change fontWeight from:
```typescript
fontWeight: { type: "number", enum: [800, 900] },
```
to:
```typescript
fontWeight: { type: "number" },
```

- [ ] **Step 2: Verify server compiles**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p server/tsconfig.json`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/settings.ts
git commit -m "feat: accept fontFamily in settings API schema"
```
