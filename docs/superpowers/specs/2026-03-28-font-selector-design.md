# Font Selector for Caption Styles

## Summary

Add a font family selector to the caption styles panel in the shorts editor. Users can choose from a curated list of 8 Google Fonts optimized for vertical short captions. The weight dropdown auto-adapts to show only weights available for the selected font.

## Font Registry

| Font Key | Available Weights | Style |
|----------|------------------|-------|
| Montserrat | 400, 500, 600, 700, 800, 900 | Clean geometric sans |
| Inter | 400, 500, 600, 700, 800, 900 | Neutral sans |
| Oswald | 400, 500, 600, 700 | Condensed sans |
| Bebas Neue | 400 | Bold condensed display |
| Poppins | 400, 500, 600, 700, 800, 900 | Rounded geometric sans |
| Bangers | 400 | Comic/impact display |
| Space Mono | 400, 700 | Monospace |
| Space Grotesk | 400, 500, 600, 700 | Techy geometric sans |

## Type Changes (`shared/types.ts`)

- Add `fontFamily` field to `CaptionStyles` with type `string`. Default: `"Montserrat"`.
- Widen `fontWeight` from `800 | 900` to `number` to support per-font weight sets.
- `DEFAULT_CAPTION_STYLES.fontFamily = "Montserrat"`.

Backward compatibility: existing persisted configs without `fontFamily` fall back to `"Montserrat"` via the default.

## Font Loading (`client/src/components/CaptionOverlay.tsx`)

- Define a `FONT_REGISTRY` map: font key -> `{ loadFont, weights }`.
- Each font is a static import from `@remotion/google-fonts/<FontName>`.
- At render time, look up `captionStyles.fontFamily` in the registry, call `loadFont()` with the appropriate weights and `latin` + `latin-ext` subsets, and use the returned `fontFamily` CSS string.
- Fallback: if the font key is not found in the registry, fall back to Montserrat.

## UI Changes (`client/src/components/StudioView.tsx`)

- Add a **Font** `<select>` dropdown in the Caption Styles section, placed above the existing Size slider.
- Matches the existing dropdown style (same as Weight and Transform selectors).
- Options: the 8 font keys from the registry.
- When the selected font changes:
  - Update `captionStyles.fontFamily`.
  - Check if the current `fontWeight` is available for the new font.
  - If not, snap to the nearest available weight (prefer highest available).
  - Update the Weight dropdown options to reflect the new font's available weights.

## Settings API (`server/src/routes/settings.ts`)

No server changes required. The settings API stores `captionStyles` as a partial object and passes it through. Adding `fontFamily` as a new string field works without schema changes.

## Render Path

No changes required. `RenderService` already passes `captionStyles` as `inputProps` to Remotion. Font loading happens inside the Remotion bundle via `CaptionOverlay`.

## Files to Modify

1. `shared/types.ts` — add `fontFamily` to `CaptionStyles`, widen `fontWeight`
2. `client/src/components/CaptionOverlay.tsx` — font registry + dynamic loading
3. `client/src/components/StudioView.tsx` — font dropdown + weight auto-adapt
