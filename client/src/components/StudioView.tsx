import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord, ViralClip, ClipSegment, ClipRenderState, CaptionStyles } from "@lusk/shared";
import {
  DEFAULT_CAPTION_STYLES,
  getClipSegments,
  getClipRenderKey,
} from "@lusk/shared";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  type CompSegment,
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

type SegmentLayout = {
  startFromInFrames: number;
  durationInFrames: number;
  /** Frame-snapped source start in ms (used for caption remapping). */
  snappedStartMs: number;
};

/** Compute the per-segment frame layout. Mirrors RenderService.computeSegmentLayouts. */
function buildSegmentLayouts(segments: ClipSegment[], fps: number): SegmentLayout[] {
  return segments.map((seg) => {
    const startFrame = Math.round((seg.startMs / 1000) * fps);
    const snappedStartMs = (startFrame / fps) * 1000;
    const durationInFrames = Math.max(
      1,
      Math.ceil(((seg.endMs - snappedStartMs) / 1000) * fps)
    );
    return { startFromInFrames: startFrame, durationInFrames, snappedStartMs };
  });
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

  // Segments (canonical). Initialized from existing clip segments OR from legacy trim deltas.
  const [segments, setSegments] = useState<ClipSegment[]>(() => getClipSegments(clip));

  // Per-segment editable text inputs (so partial typing doesn't wipe state).
  const [segmentEdits, setSegmentEdits] = useState<{ start: string; end: string }[]>(() =>
    getClipSegments(clip).map((s) => ({
      start: formatTimeInput(s.startMs),
      end: formatTimeInput(s.endMs),
    }))
  );

  // Build segment layouts (frame-aligned).
  const segmentLayouts = useMemo(() => buildSegmentLayouts(segments, fps), [segments, fps]);
  const clipDurationInFrames = useMemo(
    () => segmentLayouts.reduce((sum, s) => sum + s.durationInFrames, 0),
    [segmentLayouts]
  );

  const compSegments: CompSegment[] = useMemo(
    () => segmentLayouts.map((s) => ({
      startFromInFrames: s.startFromInFrames,
      durationInFrames: s.durationInFrames,
    })),
    [segmentLayouts]
  );

  const handlePersistState = useCallback(
    (updates: Partial<ViralClip>) => {
      onClipUpdate({ ...clip, ...updates });
    },
    [clip, onClipUpdate]
  );

  /** Persist segments as the canonical state; clear legacy trim deltas. */
  const persistSegments = useCallback(
    (next: ClipSegment[]) => {
      handlePersistState({ segments: next, trimStartDelta: 0, trimEndDelta: 0 });
    },
    [handlePersistState]
  );

  const updateSegmentBoundary = useCallback(
    (index: number, key: "startMs" | "endMs", ms: number) => {
      setSegments((prev) => {
        const next = prev.map((s, i) => (i === index ? { ...s, [key]: ms } : s));
        persistSegments(next);
        return next;
      });
    },
    [persistSegments]
  );

  const handleSegmentInputChange = useCallback(
    (index: number, field: "start" | "end", raw: string) => {
      setSegmentEdits((prev) =>
        prev.map((e, i) => (i === index ? { ...e, [field]: raw } : e))
      );
      const ms = parseTimeInput(raw);
      if (ms == null) return;
      updateSegmentBoundary(index, field === "start" ? "startMs" : "endMs", ms);
    },
    [updateSegmentBoundary]
  );

  const addCut = useCallback(() => {
    setSegments((prev) => {
      const last = prev[prev.length - 1];
      const gap = 1000;
      const newStart = last.endMs + gap;
      const newEnd = newStart + 5000;
      const next = [...prev, { startMs: newStart, endMs: newEnd }];
      persistSegments(next);
      setSegmentEdits((edits) => [
        ...edits,
        { start: formatTimeInput(newStart), end: formatTimeInput(newEnd) },
      ]);
      return next;
    });
  }, [persistSegments]);

  const removeSegment = useCallback(
    (index: number) => {
      setSegments((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((_, i) => i !== index);
        persistSegments(next);
        setSegmentEdits((edits) => edits.filter((_, i) => i !== index));
        return next;
      });
    },
    [persistSegments]
  );

  // Trimmed clip (canonical for render) — uses segments.
  const trimmedClip: ViralClip = useMemo(() => ({
    ...clip,
    segments,
    startMs: segments[0].startMs,
    endMs: segments[segments.length - 1].endMs,
    speakerOffsetX: offsetX,
    trimStartDelta: 0,
    trimEndDelta: 0,
    captionEdits: clip.captionEdits,
    captionOffset: clip.captionOffset,
  }), [clip, segments, offsetX]);

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

  // Captions overlapping any segment, sorted by source-time globalIndex (for the textarea).
  const clipCaptionIndices = useMemo(
    () =>
      captions
        .map((c, i) => ({ caption: c, globalIndex: i }))
        .filter(({ caption }) =>
          segments.some((seg) => caption.endMs > seg.startMs && caption.startMs < seg.endMs)
        ),
    [captions, segments]
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

  // Build remotion captions remapped onto the multi-segment output timeline.
  const remotionCaptions: Caption[] = useMemo(() => {
    const result: Caption[] = [];
    let cumOutputMs = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const layout = segmentLayouts[i];
      const segOutputMs = (layout.durationInFrames / fps) * 1000;
      for (const { caption: c, globalIndex } of clipCaptionIndices) {
        if (c.endMs <= seg.startMs || c.startMs >= seg.endMs) continue;
        const clippedStart = Math.max(c.startMs, seg.startMs);
        const clippedEnd = Math.min(c.endMs, seg.endMs);
        const startMs = clippedStart - layout.snappedStartMs + cumOutputMs + captionOffset;
        const endMs = clippedEnd - layout.snappedStartMs + cumOutputMs + captionOffset;
        const tsMs =
          c.timestampMs != null
            ? Math.min(Math.max(c.timestampMs, clippedStart), clippedEnd) -
              layout.snappedStartMs +
              cumOutputMs +
              captionOffset
            : null;
        result.push({
          text: captionEdits[globalIndex] ?? c.text,
          startMs,
          endMs,
          timestampMs: tsMs,
          confidence: c.confidence,
        });
      }
      cumOutputMs += segOutputMs;
    }
    return result.sort((a, b) => a.startMs - b.startMs);
  }, [segments, segmentLayouts, clipCaptionIndices, captionEdits, captionOffset, fps]);

  const clipDurationSec = (
    segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) / 1000
  ).toFixed(1);
  const totalDurationSec = (durationInFrames / fps).toFixed(1);

  const handleRender = useCallback(async () => {
    const destination = await promptForSaveDestination(suggestedFilename);
    if (!destination) return;
    setPendingSaveDestination(destination);
    playerRef.current?.pause();
    onRender(trimmedClip, offsetX, remotionCaptions);
  }, [onRender, trimmedClip, offsetX, remotionCaptions, suggestedFilename]);

  const isMultiSegment = segments.length > 1;

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
                segments: compSegments,
                startFrom: compSegments[0]?.startFromInFrames ?? 0,
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

          {/* Segments (cuts) */}
          <div className="control-group">
            <label className="control-label">
              {isMultiSegment ? `Segments (${segments.length})` : "Segment"}
            </label>
            <div className="segments-list">
              {segments.map((seg, i) => (
                <div key={i} className="segment-row">
                  <span className="segment-label">{i + 1}.</span>
                  <input
                    type="text"
                    className="segment-time-input"
                    value={segmentEdits[i]?.start ?? formatTimeInput(seg.startMs)}
                    onChange={(e) => handleSegmentInputChange(i, "start", e.target.value)}
                    onBlur={() => setSegmentEdits((prev) =>
                      prev.map((p, j) => (j === i ? { ...p, start: formatTimeInput(segments[i].startMs) } : p))
                    )}
                    placeholder="0:00"
                  />
                  <span className="segment-dash">—</span>
                  <input
                    type="text"
                    className="segment-time-input"
                    value={segmentEdits[i]?.end ?? formatTimeInput(seg.endMs)}
                    onChange={(e) => handleSegmentInputChange(i, "end", e.target.value)}
                    onBlur={() => setSegmentEdits((prev) =>
                      prev.map((p, j) => (j === i ? { ...p, end: formatTimeInput(segments[i].endMs) } : p))
                    )}
                    placeholder="0:00"
                  />
                  <span className="segment-duration">
                    {((seg.endMs - seg.startMs) / 1000).toFixed(1)}s
                  </span>
                  {segments.length > 1 && (
                    <button
                      type="button"
                      className="segment-remove"
                      onClick={() => removeSegment(i)}
                      title="Remove segment"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="secondary segment-add" onClick={addCut}>
              + Add cut
            </button>
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
