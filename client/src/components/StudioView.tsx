import { useState, useMemo } from "react";
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord, ViralClip } from "@lusk/shared";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
} from "./VideoComposition";
import "./StudioView.css";

interface StudioViewProps {
  videoUrl: string;
  captions: CaptionWord[];
  clip: ViralClip;
  onRender: (clip: ViralClip) => void;
  onBack: () => void;
  outputUrl: string | null;
  isRendering: boolean;
}

export function StudioView({
  videoUrl,
  captions,
  clip,
  onRender,
  onBack,
  outputUrl,
  isRendering,
}: StudioViewProps) {
  const [offsetX, setOffsetX] = useState(0);


  const startFrame = Math.round((clip.startMs / 1000) * COMP_FPS);
  const actualStartMs = (startFrame / COMP_FPS) * 1000;
  
  const durationInFrames = Math.max(
    1,
    Math.ceil(((clip.endMs - actualStartMs) / 1000) * COMP_FPS)
  );

  // Filter and shift captions to be relative to clip start based on actual frame start
  const remotionCaptions: Caption[] = useMemo(
    () =>
      captions
        .filter((c) => c.endMs > clip.startMs && c.startMs < clip.endMs)
        .map((c) => ({
          text: c.text,
          startMs: c.startMs - actualStartMs,
          endMs: c.endMs - actualStartMs,
          timestampMs: c.timestampMs != null ? c.timestampMs - actualStartMs : null,
          confidence: c.confidence,
        })),
    [captions, clip.startMs, clip.endMs, actualStartMs]
  );

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

        <div className="studio-actions">
          {!outputUrl && !isRendering && (
            <button className="primary" onClick={() => onRender(clip)}>
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
