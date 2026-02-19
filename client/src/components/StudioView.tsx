import { useState, useMemo, useCallback, useEffect } from "react";
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord, ViralClip, ClipRenderState } from "@lusk/shared";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
} from "./VideoComposition";
import "./StudioView.css";

// Whisper timestamps tend to be slightly early; this offset ensures
// the last caption has time to display before the clip cuts off.
const CAPTION_DELAY_MS = 500;

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
  onRender: (clip: ViralClip, offsetX: number, captions: Caption[]) => void;
  onBack: () => void;
  renders: Record<string, ClipRenderState>;
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
  onRender,
  onBack,
  renders,
}: StudioViewProps) {
  const [offsetX, setOffsetX] = useState(0);

  // Trim adjustments (in ms, relative to original clip boundaries)
  const [trimStartDelta, setTrimStartDelta] = useState(0);
  const [trimEndDelta, setTrimEndDelta] = useState(CAPTION_DELAY_MS); // default: add caption delay

  // Effective clip boundaries after trim
  const effectiveStartMs = clip.startMs + trimStartDelta;
  const effectiveEndMs = clip.endMs + trimEndDelta;

  // The clip we'll actually render (with trim applied)
  const trimmedClip: ViralClip = useMemo(() => ({
    ...clip,
    startMs: effectiveStartMs,
    endMs: effectiveEndMs,
  }), [clip, effectiveStartMs, effectiveEndMs]);

  const key = clipKey(trimmedClip);
  const renderState = renders[key] ?? null;
  const isRendering = renderState?.status === "rendering";
  const outputUrl = renderState?.outputUrl ?? null;
  const renderProgress = renderState?.progress ?? 0;
  const renderMessage = renderState?.message ?? "";

  const startFrame = Math.round((effectiveStartMs / 1000) * COMP_FPS);
  const actualStartMs = (startFrame / COMP_FPS) * 1000;
  
  const durationInFrames = Math.max(
    1,
    Math.ceil(((effectiveEndMs - actualStartMs) / 1000) * COMP_FPS)
  );


  // Clip captions (original, with global indices)
  const clipCaptionIndices = useMemo(
    () => captions
      .map((c, i) => ({ caption: c, globalIndex: i }))
      .filter(({ caption }) => caption.endMs > effectiveStartMs && caption.startMs < effectiveEndMs),
    [captions, effectiveStartMs, effectiveEndMs]
  );

  // Per-caption text overrides (keyed by global index)
  const [captionEdits, setCaptionEdits] = useState<Record<number, string>>({});
  
  // Caption timing offset (in ms) to adjust sync
  const [captionOffset, setCaptionOffset] = useState(0);

  // The editable text shown in the textarea
  const captionText = useMemo(
    () => clipCaptionIndices
      .map(({ caption, globalIndex }) => captionEdits[globalIndex] ?? caption.text)
      .join(""),
    [clipCaptionIndices, captionEdits]
  );

  // Reset edits/offset when clip changes
  useEffect(() => {
    setCaptionEdits({});
    setCaptionOffset(0);
  }, [clip.startMs, clip.endMs]);

  const handleCaptionTextChange = useCallback(
    (newText: string) => {
      // Split the edited text back into tokens matching the original word boundaries.
      // Each original caption has leading whitespace + word, so we split on word boundaries
      // and reconstruct.
      const origTokens = clipCaptionIndices.map(({ caption }) => caption.text);
      // Split the new text into tokens: preserve leading whitespace per token
      const newTokens = splitIntoTokens(newText, origTokens.length);

      const edits: Record<number, string> = {};
      for (let i = 0; i < clipCaptionIndices.length; i++) {
        const { globalIndex, caption } = clipCaptionIndices[i];
        const newToken = newTokens[i] ?? "";
        if (newToken !== caption.text) {
          edits[globalIndex] = newToken;
        }
      }
      setCaptionEdits(edits);
    },
    [clipCaptionIndices]
  );

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

  const handleRender = useCallback(() => {
    onRender(trimmedClip, offsetX, remotionCaptions);
  }, [onRender, trimmedClip, offsetX, remotionCaptions]);

  return (
    <div className="studio">
      <div className="studio-header">
        <button className="secondary studio-back" onClick={onBack}>
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
              component={VideoComposition}
              inputProps={{
                videoUrl,
                captions: remotionCaptions,
                offsetX,
                startFrom: startFrame,
              }}
              compositionWidth={COMP_WIDTH}
              compositionHeight={COMP_HEIGHT}
              durationInFrames={durationInFrames}
              fps={COMP_FPS}
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
            <label className="control-label">Captions</label>
            <textarea
              className="caption-editor"
              value={captionText}
              onChange={(e) => handleCaptionTextChange(e.target.value)}
              rows={6}
            />
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
              onChange={(e) => setTrimStartDelta(Number(e.target.value))}
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
              onChange={(e) => setTrimEndDelta(Number(e.target.value))}
              className="offset-slider"
            />
          </div>

          {/* Clip duration display */}
          <div className="trim-duration">
            Clip duration: {clipDurationSec}s
          </div>

          {/* Speaker position */}
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
              onChange={(e) => setOffsetX(Number(e.target.value))}
              className="offset-slider"
            />
          </div>

          {/* Caption Offset */}
        <div className="control-group">
          <label className="control-label">
            Caption sync
            <span className="control-value">{captionOffset >= 0 ? "+" : ""}{captionOffset}ms</span>
          </label>
          <input
            type="range"
            min={-1000}
            max={1000}
            step={50}
            value={captionOffset}
            onChange={(e) => setCaptionOffset(Number(e.target.value))}
            className="offset-slider"
          />
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
            {!outputUrl && !isRendering && (
              <button className="primary" onClick={handleRender}>
                Render Video
              </button>
            )}
            {isRendering && (
              <button className="primary" disabled>
                Rendering...
              </button>
            )}
            {outputUrl && (
              <a href={outputUrl} download className="download-btn">
                Download Video
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
