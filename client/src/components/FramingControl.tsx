import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { FramingKeyframe, FramingMode } from "@lusk/shared";
import { framingCenterAt } from "@lusk/shared";
import type { FramingStatus } from "../hooks/useFraming";

const MODES: { mode: FramingMode; label: string; hint: string }[] = [
  { mode: "speaker", label: "Whoever speaks", hint: "Gives the frame to whoever is talking and cuts between people" },
  { mode: "face", label: "Biggest face", hint: "Follows the most prominent face, panning smoothly when it moves" },
  { mode: "pick", label: "Pick person", hint: "Follows the person you click in the full frame below" },
  { mode: "manual", label: "Manual", hint: "A fixed position you set with the slider" },
];

interface FramingControlProps {
  mode: FramingMode;
  subjectX: number | undefined;
  offsetX: number;
  status: FramingStatus;
  error: string | null;
  keyframes: FramingKeyframe[] | null;
  /** Clip start in the source, to map player frames to source time. */
  clipStartMs: number;
  fps: number;
  videoUrl: string;
  /** Source width / height. */
  sourceAspectRatio: number;
  playerRef: React.RefObject<PlayerRef | null>;
  onModeChange: (mode: FramingMode) => void;
  /** `x` is normalized source x, `t` seconds into the clip of the frame it was picked on. */
  onSubjectChange: (x: number, t: number) => void;
  onOffsetChange: (px: number) => void;
}

/** Crop width as a fraction of the source width: the 9:16 window over the landscape frame. */
function cropFraction(sourceAspectRatio: number): number {
  return Math.min(1, (9 / 16) / sourceAspectRatio);
}

export function FramingControl({
  mode,
  subjectX,
  offsetX,
  status,
  error,
  keyframes,
  clipStartMs,
  fps,
  videoUrl,
  sourceAspectRatio,
  playerRef,
  onModeChange,
  onSubjectChange,
  onOffsetChange,
}: FramingControlProps) {
  return (
    <div className="control-group">
      <label className="control-label">
        Framing
        <span className="control-value framing-status">
          {mode !== "manual" && status === "tracking" && "Tracking…"}
          {mode !== "manual" && status === "ready" && "Tracked"}
          {mode !== "manual" && status === "error" && "Failed"}
          {mode === "manual" && `${offsetX}px`}
        </span>
      </label>
      <div className="framing-modes" role="radiogroup" aria-label="Framing mode">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={mode === m.mode}
            className={`framing-mode${mode === m.mode ? " active" : ""}`}
            title={m.hint}
            onClick={() => onModeChange(m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "manual" && (
        <input
          type="range"
          min={-300}
          max={300}
          step={5}
          value={offsetX}
          onChange={(e) => onOffsetChange(Number(e.target.value))}
          className="offset-slider"
          aria-label="Speaker position"
        />
      )}

      {mode === "pick" && (
        <PickPerson
          subjectX={subjectX}
          keyframes={keyframes}
          clipStartMs={clipStartMs}
          fps={fps}
          videoUrl={videoUrl}
          sourceAspectRatio={sourceAspectRatio}
          playerRef={playerRef}
          onPick={onSubjectChange}
        />
      )}

      {status === "error" && error && mode !== "manual" && (
        <p className="framing-error">{error}</p>
      )}
    </div>
  );
}

/**
 * The full landscape frame at the player's position, with the 9:16 window the export
 * would cut drawn over it. Clicking a person makes the crop follow them.
 */
function PickPerson({
  subjectX,
  keyframes,
  clipStartMs,
  fps,
  videoUrl,
  sourceAspectRatio,
  playerRef,
  onPick,
}: {
  subjectX: number | undefined;
  keyframes: FramingKeyframe[] | null;
  clipStartMs: number;
  fps: number;
  videoUrl: string;
  sourceAspectRatio: number;
  playerRef: React.RefObject<PlayerRef | null>;
  onPick: (x: number, t: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [clipTime, setClipTime] = useState(0);

  // Follow the player while it is paused or scrubbed — a still frame is what you aim at
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const sync = () => setClipTime(player.getCurrentFrame() / fps);
    sync();
    player.addEventListener("pause", sync);
    player.addEventListener("seeked", sync);
    return () => {
      player.removeEventListener("pause", sync);
      player.removeEventListener("seeked", sync);
    };
  }, [playerRef, fps]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.currentTime = clipStartMs / 1000 + clipTime;
  }, [clipStartMs, clipTime]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    onPick(Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000, Math.round(clipTime * 10) / 10);
  }, [onPick, clipTime]);

  const crop = cropFraction(sourceAspectRatio);
  const center = keyframes ? framingCenterAt(keyframes, clipTime) : subjectX ?? 0.5;
  const left = Math.max(0, Math.min(1 - crop, center - crop / 2));

  return (
    <div className="pick-person">
      <div
        className="pick-person-frame"
        style={{ aspectRatio: String(sourceAspectRatio) }}
        onClick={handleClick}
        title="Click the person the crop should follow"
      >
        <video ref={videoRef} src={videoUrl} muted playsInline preload="auto" />
        <div className="pick-person-window" style={{ left: `${left * 100}%`, width: `${crop * 100}%` }} />
        {subjectX != null && <div className="pick-person-marker" style={{ left: `${subjectX * 100}%` }} />}
      </div>
      <p className="pick-person-hint">
        {subjectX == null ? "Click the person to follow." : "Click another person to switch. Pause the player to aim at a different moment."}
      </p>
    </div>
  );
}
