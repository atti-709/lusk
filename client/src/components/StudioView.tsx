import { useState, useMemo, useCallback } from "react";
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

interface StudioViewProps {
  videoUrl: string;
  captions: CaptionWord[];
  clip: ViralClip;
  onRender: (clip: ViralClip, offsetX: number) => void;
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


  // Filter and shift captions to be relative to clip start based on actual frame start
  const remotionCaptions: Caption[] = useMemo(
    () =>
      captions
        .filter((c) => c.endMs > effectiveStartMs && c.startMs < effectiveEndMs)
        .map((c) => ({
          text: c.text,
          startMs: c.startMs - actualStartMs,
          endMs: c.endMs - actualStartMs,
          timestampMs: c.timestampMs != null ? c.timestampMs - actualStartMs : null,
          confidence: c.confidence,
        })),
    [captions, effectiveStartMs, effectiveEndMs, actualStartMs]
  );

  // Max trim range: ±5 seconds from original boundaries
  const maxTrimMs = 5000;
  const clipDurationSec = ((effectiveEndMs - effectiveStartMs) / 1000).toFixed(1);

  const handleRender = useCallback(() => {
    onRender(trimmedClip, offsetX);
  }, [onRender, trimmedClip, offsetX]);

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
            maxHeight: "70vh",
            borderRadius: 12,
            overflow: "hidden",
          }}
          controls
          autoPlay
          loop
        />
      </div>

      <div className="studio-controls">
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
  );
}
