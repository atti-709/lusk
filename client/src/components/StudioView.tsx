import { useState, useMemo } from "react";
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import type { CaptionWord } from "@lusk/shared";
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
  durationMs: number;
  onRender: () => void;
  outputUrl: string | null;
  isRendering: boolean;
}

export function StudioView({
  videoUrl,
  captions,
  durationMs,
  onRender,
  outputUrl,
  isRendering,
}: StudioViewProps) {
  const [offsetX, setOffsetX] = useState(0);

  const remotionCaptions: Caption[] = useMemo(
    () =>
      captions.map((c) => ({
        text: c.text,
        startMs: c.startMs,
        endMs: c.endMs,
        timestampMs: c.timestampMs,
        confidence: c.confidence,
      })),
    [captions]
  );

  const durationInFrames = Math.max(
    1,
    Math.ceil((durationMs / 1000) * COMP_FPS)
  );

  return (
    <div className="studio">
      <div className="studio-player">
        <Player
          component={VideoComposition}
          inputProps={{
            videoUrl,
            captions: remotionCaptions,
            offsetX,
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
            <button className="primary" onClick={onRender}>
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
