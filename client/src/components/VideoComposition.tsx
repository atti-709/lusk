import {
  AbsoluteFill,
  Audio,
  Sequence,
  OffthreadVideo,
  useVideoConfig,
} from "remotion";
import type { Caption } from "@remotion/captions";
import { CaptionOverlay } from "./CaptionOverlay";
import type { CaptionStyles } from "@lusk/shared";

export const COMP_WIDTH = 1080;
export const COMP_HEIGHT = 1920;
export const COMP_FPS = 23.976;

/** Frames by which the outro overlaps the end of the main clip. */
export const OUTRO_OVERLAP_FRAMES = 4;

function ClipVideo({
  src,
  startFromInFrames,
  offsetX,
  sourceAspectRatio,
}: {
  src: string;
  startFromInFrames: number;
  offsetX: number;
  sourceAspectRatio?: number | null;
}) {
  const isPortrait = sourceAspectRatio != null && sourceAspectRatio < 1;
  const landscapeWidthPct =
    sourceAspectRatio != null
      ? (COMP_HEIGHT * sourceAspectRatio / COMP_WIDTH) * 100
      : (COMP_HEIGHT * (16 / 9) / COMP_WIDTH) * 100;

  const videoStyle = isPortrait
    ? {
        width: "100%",
        height: "100%",
        objectFit: "contain" as const,
        position: "absolute" as const,
        left: 0,
        top: 0,
      }
    : {
        width: `${landscapeWidthPct}%`,
        height: "100%",
        objectFit: "cover" as const,
        position: "absolute" as const,
        left: "50%",
        transform: `translateX(calc(-50% + ${offsetX}px))`,
      };

  // Negative-from trick: shifts the video so playback begins at startFromInFrames.
  // muted=true: audio is rendered separately via <Audio> so we can fade it out at the clip end.
  return (
    <Sequence from={-startFromInFrames}>
      <OffthreadVideo src={src} muted style={videoStyle} />
    </Sequence>
  );
}

function OutroVideo({ src }: { src: string }) {
  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
}

export type VideoCompositionProps = {
  videoUrl: string;
  captions: Caption[];
  offsetX: number;
  /** Frame in the source video where the clip starts. */
  startFrom?: number;
  outroSrc?: string;
  outroDurationInFrames?: number;
  outroOverlapFrames?: number;
  sourceAspectRatio?: number | null;  // videoWidth / videoHeight; null → assume landscape
  captionStyles?: CaptionStyles;
};

export function VideoComposition({
  videoUrl,
  captions,
  offsetX,
  startFrom = 0,
  outroSrc,
  outroDurationInFrames = 0,
  outroOverlapFrames = OUTRO_OVERLAP_FRAMES,
  sourceAspectRatio,
  captionStyles,
}: VideoCompositionProps) {
  const { durationInFrames, fps } = useVideoConfig();

  const hasOutro = !!outroSrc && outroDurationInFrames > 0;
  const overlap = hasOutro ? outroOverlapFrames : 0;

  // total duration = clipDuration + outroDuration - overlap
  const clipDurationInFrames = hasOutro
    ? durationInFrames - outroDurationInFrames + overlap
    : durationInFrames;

  // Outro begins overlap frames before the clip ends
  const outroFrom = clipDurationInFrames - overlap;

  // 1-second fade-to-zero at the end of the clip so audio doesn't cut off abruptly.
  const finalFadeFrames = Math.round(fps);
  const finalFadeStart = clipDurationInFrames - finalFadeFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Main clip: video + audio + captions */}
      <Sequence durationInFrames={clipDurationInFrames}>
        <AbsoluteFill>
          {videoUrl && (
            <ClipVideo
              src={videoUrl}
              startFromInFrames={startFrom}
              offsetX={offsetX}
              sourceAspectRatio={sourceAspectRatio}
            />
          )}
        </AbsoluteFill>

        {/* Audio rendered separately (video is muted) so we can fade it out at the clip end. */}
        {videoUrl && (
          <Audio
            src={videoUrl}
            startFrom={startFrom}
            endAt={startFrom + clipDurationInFrames}
            volume={(frame) =>
              frame >= finalFadeStart
                ? Math.max(0, 1 - (frame - finalFadeStart) / finalFadeFrames)
                : 1
            }
          />
        )}

        {captions.length > 0 && <CaptionOverlay captions={captions} captionStyles={captionStyles} />}
      </Sequence>

      {/* Outro video — starts OUTRO_OVERLAP_FRAMES before clip ends, audio fades out */}
      {hasOutro && (
        <Sequence from={outroFrom} durationInFrames={outroDurationInFrames}>
          <OutroVideo src={outroSrc!} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
}
