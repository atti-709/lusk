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
  onBack: () => void;
}

export function ClipSelector({ clips, videoUrl, onSelect, onBack }: ClipSelectorProps) {
  return (
    <div className="clip-selector">
      <div className="clip-selector-header">
        <button className="secondary studio-back" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Review
        </button>
        <div className="clip-selector-title-group">
          <h2>Pick a clip to edit</h2>
          <p className="subtitle">
            {clips.length} viral moment{clips.length !== 1 ? "s" : ""} detected
          </p>
        </div>
      </div>

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
    </div>
  );
}
