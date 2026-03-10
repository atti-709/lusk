import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord, ViralClip, ClipRenderState, CaptionStyles } from "@lusk/shared";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
} from "./VideoComposition";
import { useOutroConfig } from "../hooks/useOutroConfig";
import { useAppSettings } from "../contexts/AppSettingsContext";
import "./StudioView.css";

// Whisper timestamps tend to be slightly early; this offset ensures
// the last caption has time to display before the clip cuts off.
const CAPTION_DELAY_MS = 900;

/**
 * Split edited text back into N tokens matching the original caption structure.
 * Each token in Remotion captions is typically " word" (leading space + word).
 * We split the full text by whitespace boundaries and map back by position.
 */
function splitIntoTokens(text: string, count: number): string[] {
  // Match tokens: optional leading whitespace + non-whitespace word
  const matches = text.match(/\s*\S+/g) ?? [];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(matches[i] ?? "");
  }
  return result;
}

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

function clipKey(clip: { startMs: number; endMs: number }): string {
  return `${clip.startMs}-${clip.endMs}`;
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return `${min}:${sec.toString().padStart(2, "0")}.${frac}`;
}

export function StudioView({
  videoUrl,
  captions,
  clip,
  videoName: _videoName,
  onRender,
  onBack,
  renders,
  onClipUpdate,
  sourceAspectRatio,
}: StudioViewProps) {
  const playerRef = useRef<PlayerRef>(null);
  const { config: outroConfig, reload: reloadOutro } = useOutroConfig();
  const { fps, captionStyles, updateCaptionStyles, outroEnabled, setOutroEnabled } = useAppSettings();
  const isVerticalSource = sourceAspectRatio != null && sourceAspectRatio < 1;

  const [stylesOpen, setStylesOpen] = useState(false);
  const [outroOpen, setOutroOpen] = useState(false);
  const [outroUploading, setOutroUploading] = useState(false);

  // Initialize from clip state if available
  const [offsetX, setOffsetX] = useState(clip.speakerOffsetX ?? 0);

  // Trim adjustments (in ms, relative to original clip boundaries)
  const [trimStartDelta, setTrimStartDelta] = useState(clip.trimStartDelta ?? 0);
  const [trimEndDelta, setTrimEndDelta] = useState(clip.trimEndDelta ?? CAPTION_DELAY_MS);

  // Effective clip boundaries after trim
  const effectiveStartMs = clip.startMs + trimStartDelta;
  const effectiveEndMs = clip.endMs + trimEndDelta;

  // The clip we'll actually render (with trim applied)
  const trimmedClip: ViralClip = useMemo(() => ({
    ...clip,
    startMs: effectiveStartMs,
    endMs: effectiveEndMs,
    // Persist UI state in the clip object we pass around
    speakerOffsetX: offsetX,
    trimStartDelta,
    trimEndDelta,
    captionEdits: clip.captionEdits, // Pass through, updated below
    captionOffset: clip.captionOffset, // Pass through, updated below
  }), [clip, effectiveStartMs, effectiveEndMs, offsetX, trimStartDelta, trimEndDelta]);



  const key = clipKey(trimmedClip);
  const renderState = renders[key] ?? null;
  const isRendering = renderState?.status === "rendering";
  const outputUrl = renderState?.outputUrl ?? null;
  const renderProgress = renderState?.progress ?? 0;
  const renderMessage = renderState?.message ?? "";

  const suggestedFilename = `${trimmedClip.title.replace(/[^a-z0-9]/gi, "_")}.mp4`;

  // Pending save destination chosen when user clicked Render (before render started)
  const [pendingSaveDestination, setPendingSaveDestination] = useState<SaveDestination | null>(null);

  // When render completes, save to the destination chosen at the start
  useEffect(() => {
    if (renderState?.status !== "exported" || !outputUrl || !pendingSaveDestination) return;
    saveToDestination(outputUrl, pendingSaveDestination, suggestedFilename)
      .catch(console.error)
      .finally(() => setPendingSaveDestination(null));
  }, [renderState?.status, outputUrl, pendingSaveDestination, suggestedFilename]);

  const startFrame = Math.round((effectiveStartMs / 1000) * fps);
  const actualStartMs = (startFrame / fps) * 1000;

  const clipDurationInFrames = Math.max(
    1,
    Math.ceil(((effectiveEndMs - actualStartMs) / 1000) * fps)
  );

  const outroActive = outroEnabled && outroConfig != null;
  const outroDurationInFrames = outroActive ? outroConfig.outroDurationInFrames : 0;
  const outroOverlap = outroActive ? outroConfig.outroOverlapFrames : 4;
  const overlap = outroDurationInFrames > 0 ? outroOverlap : 0;
  const durationInFrames = clipDurationInFrames + outroDurationInFrames - overlap;


  // Clip captions (original, with global indices)
  const clipCaptionIndices = useMemo(
    () => captions
      .map((c, i) => ({ caption: c, globalIndex: i }))
      .filter(({ caption }) => caption.endMs > effectiveStartMs && caption.startMs < effectiveEndMs),
    [captions, effectiveStartMs, effectiveEndMs]
  );

  // Per-caption text overrides (keyed by global index)
  // Initialize from clip if available
  const [captionEdits, setCaptionEdits] = useState<Record<number, string>>(clip.captionEdits ?? {});
  
  // Caption timing offset (in ms) to adjust sync
  const [captionOffset, setCaptionOffset] = useState(clip.captionOffset ?? 0);

  // Update local state when clip ID changes (switching clips)
  // We identify clip switch by start/end/title change.
 
  
  // The editable text shown in the textarea
  const captionText = useMemo(
    () => clipCaptionIndices
      .map(({ caption, globalIndex }) => captionEdits[globalIndex] ?? caption.text)
      .join(""),
    [clipCaptionIndices, captionEdits]
  );
  // ^ WARNING: clip.startMs/endMs MIGHT change if we update them via onClipUpdate (if we stored "effective" start/end in clip)
  // But `clip` prop coming in has `startMs` / `endMs` as the *original* clip boundaries? 
  // In `App.tsx`: `setViralClips` updates the array. 
  // The `clip` object in `shared/types.ts` has `startMs` / `endMs`. 
  // Are those original or effective? 
  // The `trimmedClip` calculation `effectiveStartMs = clip.startMs + trimStartDelta` implies `clip.startMs` is the base.
  // We are NOT updating `clip.startMs` in `trimmedClip` to be the new effective one permanently, 
  // we are just calculating effective for rendering. 
  // Wait, `trimmedClip` memo:
  // `startMs: effectiveStartMs` 
  // If we pass `trimmedClip` to `onClipUpdate`, then `clip.startMs` in App state BECOMES `effectiveStartMs`.
  // Then next render, `clip.startMs` is larger. `effectiveStartMs` = new `clip.startMs` + `trimStartDelta`. Double apply!
  // 
  // FIX: We must NOT mutate `startMs` / `endMs` in the persisted clip state if they represent the "base" clip.
  // `ViralClip` definition: `startMs`, `endMs`. 
  // If we want to persist "trim", we should store `trimStartDelta` and `trimEndDelta`, 
  // and KEEP `startMs`/`endMs` as the ORIGINAL detection boundaries.
  // 
  // In `trimmedClip` memo above, I did:
  // `startMs: effectiveStartMs`
  // This is correct FOR RENDERING (the player needs to know where to start).
  // But when saving back to `onClipUpdate`, we should probably save the *original* start/end + deltas, 
  // OR we accept that `startMs` changes. 
  // If `startMs` changes, `trimStartDelta` should probably reset to 0? 
  // 
  // Let's stick to: `ViralClip` in state tracks the ORIGINAL detection. 
  // We store `trimStartDelta`. 
  // `trimmedClip` (for render/player) has adjusted start/end.
  // When calling `onClipUpdate`, we should pass the ORIGINAL start/end, but with updated metadata.
  
  const handlePersistState = useCallback((
    updates: Partial<ViralClip>
  ) => {
    // We want to update the metadata, but keep the original start/end/title 
    // so we don't drift or break identity.
    onClipUpdate({
      ...clip, // The current prop, which should be the source of truth
      ...updates,
    });
  }, [clip, onClipUpdate]);

  // Refactored state setters to also trigger persist
  const updateOffsetX = useCallback((val: number) => {
    setOffsetX(val);
    handlePersistState({ speakerOffsetX: val });
  }, [handlePersistState]);

  const updateTrimStart = useCallback((val: number) => {
    setTrimStartDelta(val);
    handlePersistState({ trimStartDelta: val });
  }, [handlePersistState]);

  const updateTrimEnd = useCallback((val: number) => {
    setTrimEndDelta(val);
    handlePersistState({ trimEndDelta: val });
  }, [handlePersistState]);

  const updateCaptionOffset = useCallback((val: number) => {
    setCaptionOffset(val);
    handlePersistState({ captionOffset: val });
  }, [handlePersistState]);

  const updateCaptionEdits = useCallback((val: Record<number, string>) => {
    setCaptionEdits(val);
    handlePersistState({ captionEdits: val });
  }, [handlePersistState]);

  const handleCaptionTextChange = useCallback(
    (newText: string) => {
      const origTokens = clipCaptionIndices.map(({ caption }) => caption.text);
      const newTokens = splitIntoTokens(newText, origTokens.length);

      const edits: Record<number, string> = {};
      for (let i = 0; i < clipCaptionIndices.length; i++) {
        const { globalIndex, caption } = clipCaptionIndices[i];
        const newToken = newTokens[i] ?? "";
        if (newToken !== caption.text) {
          edits[globalIndex] = newToken;
        }
      }
      updateCaptionEdits(edits);
    },
    [clipCaptionIndices, updateCaptionEdits]
  );
  
  const handleResetCaptions = useCallback(() => {
    if (confirm("Discard all caption changes for this clip?")) {
      updateCaptionEdits({});
    }
  }, [updateCaptionEdits]);

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
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outroOverlapFrames: val }),
    });
    reloadOutro();
  }, [reloadOutro]);

  const handleStyleChange = useCallback(<K extends keyof CaptionStyles>(key: K, value: CaptionStyles[K]) => {
    const updated = { ...captionStyles, [key]: value };
    updateCaptionStyles(updated);
  }, [captionStyles, updateCaptionStyles]);

  const handleResetStyles = useCallback(() => {
    updateCaptionStyles(DEFAULT_CAPTION_STYLES);
  }, [updateCaptionStyles]);

  const isStylesModified = JSON.stringify(captionStyles) !== JSON.stringify(DEFAULT_CAPTION_STYLES);

  // Build remotion captions with edits applied
  const remotionCaptions: Caption[] = useMemo(
    () =>
      clipCaptionIndices.map(({ caption, globalIndex }) => ({
        text: captionEdits[globalIndex] ?? caption.text,
        startMs: caption.startMs - actualStartMs + captionOffset,
        endMs: caption.endMs - actualStartMs + captionOffset,
        timestampMs: caption.timestampMs != null ? caption.timestampMs - actualStartMs + captionOffset : null,
        confidence: caption.confidence,
      })),
    [clipCaptionIndices, captionEdits, actualStartMs, captionOffset]
  );

  // Max trim range: ±5 seconds from original boundaries
  const maxTrimMs = 5000;
  const clipDurationSec = ((effectiveEndMs - effectiveStartMs) / 1000).toFixed(1);
  const totalDurationSec = (durationInFrames / fps).toFixed(1);

  const handleRender = useCallback(async () => {
    const destination = await promptForSaveDestination(suggestedFilename);
    if (!destination) return; // User canceled
    setPendingSaveDestination(destination);
    playerRef.current?.pause();
    onRender(trimmedClip, offsetX, remotionCaptions);
  }, [onRender, trimmedClip, offsetX, remotionCaptions, suggestedFilename]);

  return (
    <div className="studio">
      <div className="studio-header">
        <button
          className="secondary studio-back"
          onClick={onBack}
          title="Back to clips"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to clips
        </button>
        <div className="studio-clip-title">{clip.title}</div>
      </div>

      <div className="studio-body">
        {/* Left column: video + captions editor */}
        <div className="studio-left">
          <div className="studio-player">
            <Player
              ref={playerRef}
              component={VideoComposition}
              inputProps={{
                videoUrl,
                captions: remotionCaptions,
                offsetX,
                startFrom: startFrame,
                outroSrc: outroActive ? outroConfig.outroSrc : "",
                outroDurationInFrames,
                outroOverlapFrames: outroOverlap,
                sourceAspectRatio,
                captionStyles,
              }}
              compositionWidth={COMP_WIDTH}
              compositionHeight={COMP_HEIGHT}
              durationInFrames={durationInFrames}
              fps={fps}
              style={{
                width: "100%",
                borderRadius: 12,
                overflow: "hidden",
              }}
              controls
              autoPlay
              loop
            />
          </div>
        </div>

        {/* Right column: captions + controls */}
        <div className="studio-right">
          <div className="control-group">
            <div className="control-label-row">
                <label className="control-label">Captions</label>
                <button 
                  className="reset-captions-btn" 
                  onClick={handleResetCaptions}
                  title="Reset to transcript"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 2v6h6" />
                    <path d="M2.66 15.57a10 10 0 1 0 .57-8.38" />
                  </svg>
                </button>
            </div>
            <textarea
              className="caption-editor"
              value={captionText}
              onChange={(e) => handleCaptionTextChange(e.target.value)}
              rows={4}
            />
          </div>

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

          {/* Trim Start */}
          <div className="control-group">
            <label className="control-label">
              Trim start
              <span className="control-value">{trimStartDelta >= 0 ? "+" : ""}{(trimStartDelta / 1000).toFixed(1)}s → {formatTimestamp(effectiveStartMs)}</span>
            </label>
            <input
              type="range"
              min={-maxTrimMs}
              max={maxTrimMs}
              step={100}
              value={trimStartDelta}
              onChange={(e) => updateTrimStart(Number(e.target.value))}
              className="offset-slider"
            />
          </div>

          {/* Trim End */}
          <div className="control-group">
            <label className="control-label">
              Trim end
              <span className="control-value">{trimEndDelta >= 0 ? "+" : ""}{(trimEndDelta / 1000).toFixed(1)}s → {formatTimestamp(effectiveEndMs)}</span>
            </label>
            <input
              type="range"
              min={-maxTrimMs}
              max={maxTrimMs}
              step={100}
              value={trimEndDelta}
              onChange={(e) => updateTrimEnd(Number(e.target.value))}
              className="offset-slider"
            />
          </div>

          {/* Clip duration display */}
          <div className="trim-duration">
            Clip: {clipDurationSec}s{outroDurationInFrames > 0 && ` + outro = ${totalDurationSec}s`}
          </div>

          {/* Speaker position */}
          {!isVerticalSource && (
          <div className="control-group">
            <label className="control-label">
              Speaker position
              <span className="control-value">{offsetX}px</span>
            </label>
            <input
              type="range"
              min={-300}
              max={300}
              step={5}
              value={offsetX}
              onChange={(e) => updateOffsetX(Number(e.target.value))}
              className="offset-slider"
            />
          </div>
          )}

          {/* Caption Offset */}
        <div className="control-group">
          <label className="control-label">
            Caption sync
            <span className="control-value">{captionOffset >= 0 ? "+" : ""}{captionOffset}ms</span>
          </label>
          <input
            type="range"
            min={-1500}
            max={1500}
            step={50}
            value={captionOffset}
            onChange={(e) => updateCaptionOffset(Number(e.target.value))}
            className="offset-slider"
          />
        </div>

        {/* Outro */}
        <div className="control-group">
          <div className="collapsible-header" onClick={() => setOutroOpen(!outroOpen)}>
            <span className="control-label">
              <svg className={`collapsible-chevron${outroOpen ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Outro
            </span>
            {outroConfig && (
              <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={outroEnabled} onChange={(e) => setOutroEnabled(e.target.checked)} />
                <span className="toggle-track" />
              </label>
            )}
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

        {/* Render progress */}
          {isRendering && (
            <div className="render-progress">
              <div className="render-progress-header">
                <span className="render-progress-message">{renderMessage}</span>
                <span className="render-progress-pct">{renderProgress}%</span>
              </div>
              <div className="render-progress-track">
                <div
                  className="render-progress-fill"
                  style={{ width: `${renderProgress}%` }}
                />
              </div>
            </div>
          )}

          <div className="studio-actions">
            {isRendering ? (
              <button className="primary" disabled>
                Rendering...
              </button>
            ) : (
              <button className="primary" onClick={handleRender}>
                Render Video
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type SaveDestination = { type: "lusk"; path: string } | { type: "fileHandle"; handle: FileSystemFileHandle } | { type: "fallback" };

/** Show save dialog at start; returns destination or null if canceled. */
async function promptForSaveDestination(filename: string): Promise<SaveDestination | null> {
  const lusk = (window as Window & { lusk?: { showSaveDialog: (opts?: object) => Promise<{ canceled: boolean; filePath: string | null }> } }).lusk;
  if (lusk?.showSaveDialog) {
    const { canceled, filePath } = await lusk.showSaveDialog({
      title: "Save video",
      defaultPath: filename,
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });
    if (canceled || !filePath) return null;
    return { type: "lusk", path: filePath };
  }
  if ("showSaveFilePicker" in window) {
    try {
      const fileHandle = await (window as Window & { showSaveFilePicker: (opts: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "MP4 Video", accept: { "video/mp4": [".mp4"] } }],
      });
      return { type: "fileHandle", handle: fileHandle };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return null;
      throw err;
    }
  }
  return { type: "fallback" };
}

/** Save fetched video to the chosen destination. */
async function saveToDestination(
  url: string,
  destination: SaveDestination,
  filename: string
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch render");
  const blob = await res.blob();

  const lusk = (window as Window & { lusk?: { writeFile: (path: string, base64: string) => Promise<void> } }).lusk;
  if (destination.type === "lusk" && lusk?.writeFile) {
    const base64 = await blobToBase64(blob);
    await lusk.writeFile(destination.path, base64);
    return;
  }
  if (destination.type === "fileHandle") {
    const writable = await destination.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  // Fallback: browser download
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
