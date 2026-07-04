import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord, ViralClip, ClipRenderState, CaptionStyles } from "@lusk/shared";
import {
  DEFAULT_CAPTION_STYLES,
  getClipRange,
  getClipRenderKey,
} from "@lusk/shared";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
} from "./VideoComposition";
import { FONT_REGISTRY } from "./CaptionOverlay";
import { useOutroConfig } from "../hooks/useOutroConfig";
import { useAppSettings } from "../contexts/AppSettingsContext";
import "./StudioView.css";

/**
 * Split edited text back into N tokens matching the original caption structure.
 * Each token in Remotion captions is typically " word" (leading space + word).
 * We split the full text by whitespace boundaries and map back by position.
 */
function splitIntoTokens(text: string, count: number): string[] {
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

/** Format ms as M:SS.s for editable text input. */
function formatTimeInput(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const frac = Math.floor((abs % 1000) / 100);
  return `${sign}${min}:${sec.toString().padStart(2, "0")}.${frac}`;
}

/** Parse M:SS, M:SS.s, MM:SS, H:MM:SS or plain seconds (e.g. "12.5") to ms. Returns null on invalid input. */
function parseTimeInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const s = parseFloat(parts[0]);
    if (isNaN(s) || s < 0) return null;
    return Math.round(s * 1000);
  }
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (isNaN(m) || isNaN(s) || m < 0 || s < 0 || s >= 60) return null;
    return Math.round((m * 60 + s) * 1000);
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s) || h < 0 || m < 0 || m >= 60 || s < 0 || s >= 60) return null;
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  }
  return null;
}

type ClipLayout = {
  startFromInFrames: number;
  durationInFrames: number;
  /** Frame-snapped source start in ms (used for caption remapping). */
  snappedStartMs: number;
};

/** Compute the clip's frame layout. Mirrors RenderService.computeClipLayout. */
function buildClipLayout(startMs: number, endMs: number, fps: number): ClipLayout {
  const startFrame = Math.round((startMs / 1000) * fps);
  const snappedStartMs = (startFrame / fps) * 1000;
  const durationInFrames = Math.max(
    1,
    Math.ceil(((endMs - snappedStartMs) / 1000) * fps)
  );
  return { startFromInFrames: startFrame, durationInFrames, snappedStartMs };
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

  const [offsetX, setOffsetX] = useState(clip.speakerOffsetX ?? 0);

  // Clip range (canonical). Initialized from the clip's effective range (base + any trim deltas).
  const [range, setRange] = useState<{ startMs: number; endMs: number }>(() => getClipRange(clip));

  // Editable text inputs (so partial typing doesn't wipe state).
  const [rangeEdits, setRangeEdits] = useState<{ start: string; end: string }>(() => {
    const r = getClipRange(clip);
    return { start: formatTimeInput(r.startMs), end: formatTimeInput(r.endMs) };
  });

  // Build the frame-aligned clip layout.
  const layout = useMemo(() => buildClipLayout(range.startMs, range.endMs, fps), [range, fps]);
  const clipDurationInFrames = layout.durationInFrames;

  const handlePersistState = useCallback(
    (updates: Partial<ViralClip>) => {
      onClipUpdate({ ...clip, ...updates });
    },
    [clip, onClipUpdate]
  );

  /** Persist the range as base start/end; trims are baked in so deltas stay zero. */
  const persistRange = useCallback(
    (next: { startMs: number; endMs: number }) => {
      handlePersistState({
        startMs: next.startMs,
        endMs: next.endMs,
        trimStartDelta: 0,
        trimEndDelta: 0,
      });
    },
    [handlePersistState]
  );

  const handleRangeInputChange = useCallback(
    (field: "start" | "end", raw: string) => {
      setRangeEdits((prev) => ({ ...prev, [field]: raw }));
      const ms = parseTimeInput(raw);
      if (ms == null) return;
      setRange((prev) => {
        const next = field === "start" ? { ...prev, startMs: ms } : { ...prev, endMs: ms };
        persistRange(next);
        return next;
      });
    },
    [persistRange]
  );

  // Trimmed clip (canonical for render).
  const trimmedClip: ViralClip = useMemo(() => ({
    ...clip,
    startMs: range.startMs,
    endMs: range.endMs,
    speakerOffsetX: offsetX,
    trimStartDelta: 0,
    trimEndDelta: 0,
    captionEdits: clip.captionEdits,
    captionOffset: clip.captionOffset,
  }), [clip, range, offsetX]);

  const key = getClipRenderKey(trimmedClip);
  const renderState = renders[key] ?? null;
  const isRendering = renderState?.status === "rendering";
  const isRenderError = renderState?.status === "error";
  const outputUrl = renderState?.outputUrl ?? null;
  const renderProgress = renderState?.progress ?? 0;
  const renderMessage = renderState?.message ?? "";

  const suggestedFilename = `${trimmedClip.title.replace(/[^a-z0-9]/gi, "_")}.mp4`;

  const [pendingSaveDestination, setPendingSaveDestination] = useState<SaveDestination | null>(null);

  useEffect(() => {
    if (renderState?.status !== "exported" || !outputUrl || !pendingSaveDestination) return;
    saveToDestination(outputUrl, pendingSaveDestination, suggestedFilename)
      .catch(console.error)
      .finally(() => setPendingSaveDestination(null));
  }, [renderState?.status, outputUrl, pendingSaveDestination, suggestedFilename]);

  const outroActive = outroEnabled && outroConfig != null;
  const outroDurationInFrames = outroActive ? outroConfig.outroDurationInFrames : 0;
  const outroOverlap = outroActive ? outroConfig.outroOverlapFrames : 4;
  const overlap = outroDurationInFrames > 0 ? outroOverlap : 0;
  const durationInFrames = clipDurationInFrames + outroDurationInFrames - overlap;

  // Captions overlapping the clip range, sorted by source-time globalIndex (for the textarea).
  const clipCaptionIndices = useMemo(
    () =>
      captions
        .map((c, i) => ({ caption: c, globalIndex: i }))
        .filter(({ caption }) => caption.endMs > range.startMs && caption.startMs < range.endMs),
    [captions, range]
  );

  const [captionEdits, setCaptionEdits] = useState<Record<number, string>>(clip.captionEdits ?? {});
  const [captionOffset, setCaptionOffset] = useState(clip.captionOffset ?? 0);

  const captionText = useMemo(
    () =>
      clipCaptionIndices
        .map(({ caption, globalIndex }) => captionEdits[globalIndex] ?? caption.text)
        .join(""),
    [clipCaptionIndices, captionEdits]
  );

  const updateOffsetX = useCallback(
    (val: number) => {
      setOffsetX(val);
      handlePersistState({ speakerOffsetX: val });
    },
    [handlePersistState]
  );

  const updateCaptionOffset = useCallback(
    (val: number) => {
      setCaptionOffset(val);
      handlePersistState({ captionOffset: val });
    },
    [handlePersistState]
  );

  const updateCaptionEdits = useCallback(
    (val: Record<number, string>) => {
      setCaptionEdits(val);
      handlePersistState({ captionEdits: val });
    },
    [handlePersistState]
  );

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

  const handleStyleChange = useCallback(<K extends keyof CaptionStyles>(k: K, value: CaptionStyles[K]) => {
    const updated = { ...captionStyles, [k]: value };
    updateCaptionStyles(updated);
  }, [captionStyles, updateCaptionStyles]);

  const handleResetStyles = useCallback(() => {
    updateCaptionStyles(DEFAULT_CAPTION_STYLES);
  }, [updateCaptionStyles]);

  const isStylesModified = JSON.stringify(captionStyles) !== JSON.stringify(DEFAULT_CAPTION_STYLES);

  // Build remotion captions remapped onto the clip output timeline.
  const remotionCaptions: Caption[] = useMemo(() => {
    const result: Caption[] = [];
    for (const { caption: c, globalIndex } of clipCaptionIndices) {
      if (c.endMs <= range.startMs || c.startMs >= range.endMs) continue;
      const clippedStart = Math.max(c.startMs, range.startMs);
      const clippedEnd = Math.min(c.endMs, range.endMs);
      result.push({
        text: captionEdits[globalIndex] ?? c.text,
        startMs: clippedStart - layout.snappedStartMs + captionOffset,
        endMs: clippedEnd - layout.snappedStartMs + captionOffset,
        timestampMs:
          c.timestampMs != null
            ? Math.min(Math.max(c.timestampMs, clippedStart), clippedEnd) -
              layout.snappedStartMs +
              captionOffset
            : null,
        confidence: c.confidence,
      });
    }
    return result.sort((a, b) => a.startMs - b.startMs);
  }, [range, layout, clipCaptionIndices, captionEdits, captionOffset]);

  const clipDurationSec = ((range.endMs - range.startMs) / 1000).toFixed(1);
  const totalDurationSec = (durationInFrames / fps).toFixed(1);

  const handleRender = useCallback(async () => {
    const destination = await promptForSaveDestination(suggestedFilename);
    if (!destination) return;
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
        {/* Left column: video */}
        <div className="studio-left">
          <div className="studio-player">
            <Player
              ref={playerRef}
              component={VideoComposition}
              inputProps={{
                videoUrl,
                captions: remotionCaptions,
                offsetX,
                startFrom: layout.startFromInFrames,
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
                  <label>Font</label>
                  <select value={captionStyles.fontFamily ?? "Montserrat"} onChange={(e) => {
                    const newFont = e.target.value;
                    const entry = FONT_REGISTRY[newFont];
                    const availableWeights = entry?.weights ?? [900];
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
                  <select value={captionStyles.fontWeight} onChange={(e) => handleStyleChange("fontWeight", Number(e.target.value))}>
                    {(FONT_REGISTRY[captionStyles.fontFamily ?? "Montserrat"]?.weights ?? [900]).map((w) => (
                      <option key={w} value={w}>{w}</option>
                    ))}
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

          {/* Clip range (start / end) */}
          <div className="control-group">
            <label className="control-label">Clip range</label>
            <div className="segments-list">
              <div className="segment-row">
                <input
                  type="text"
                  className="segment-time-input"
                  value={rangeEdits.start}
                  onChange={(e) => handleRangeInputChange("start", e.target.value)}
                  onBlur={() => setRangeEdits((prev) => ({ ...prev, start: formatTimeInput(range.startMs) }))}
                  placeholder="0:00"
                />
                <span className="segment-dash">—</span>
                <input
                  type="text"
                  className="segment-time-input"
                  value={rangeEdits.end}
                  onChange={(e) => handleRangeInputChange("end", e.target.value)}
                  onBlur={() => setRangeEdits((prev) => ({ ...prev, end: formatTimeInput(range.endMs) }))}
                  placeholder="0:00"
                />
                <span className="segment-duration">
                  {((range.endMs - range.startMs) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
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

          {isRenderError && (
            <div className="render-error">
              <span className="render-error-label">Render failed</span>
              <pre className="render-error-message">{renderMessage}</pre>
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
