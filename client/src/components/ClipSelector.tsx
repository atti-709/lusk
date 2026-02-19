import { useRef, useEffect } from "react";
import type { ViralClip } from "@lusk/shared";
import "./ClipSelector.css";

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ClipCard({
  clip,
  videoUrl,
  onClick,
}: {
  clip: ViralClip;
  videoUrl: string;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clip.startMs / 1000;
  }, [clip.startMs]);

  const durationSec = Math.round((clip.endMs - clip.startMs) / 1000);

  return (
    <button className="clip-card" onClick={onClick}>
      <div className="clip-card-preview">
        <video
          ref={videoRef}
          src={`${videoUrl}#t=${clip.startMs / 1000}`}
          muted
          playsInline
          preload="metadata"
        />
        <span className="clip-card-duration">{durationSec}s</span>
      </div>
      <div className="clip-card-body">
        <div className="clip-card-title">{clip.title}</div>
        <div className="clip-card-hook">"{clip.hookText}"</div>
        <div className="clip-card-time">
          {formatMs(clip.startMs)} — {formatMs(clip.endMs)}
        </div>
      </div>
    </button>
  );
}

interface ClipSelectorProps {
  clips: ViralClip[];
  videoUrl: string;
  onSelect: (clip: ViralClip) => void;
  onBackToAlign: () => void;
}

export function ClipSelector({ clips, videoUrl, onSelect, onBackToAlign }: ClipSelectorProps) {
  return (
    <div className="clip-selector">
      <h2>Pick a clip to edit</h2>
      <p className="subtitle">
        {clips.length} viral moment{clips.length !== 1 ? "s" : ""} detected
      </p>

      <div className="clip-grid">
        {clips.map((clip, i) => (
          <ClipCard
            key={i}
            clip={clip}
            videoUrl={videoUrl}
            onClick={() => onSelect(clip)}
          />
        ))}
      </div>

      <button className="secondary back-to-align-btn" onClick={onBackToAlign}>
        ← Back to Align & Analyze
      </button>
    </div>
  );
}
