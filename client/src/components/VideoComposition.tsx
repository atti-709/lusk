import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
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
  startFrom,
  offsetX,
  clipDurationInFrames,
  sourceAspectRatio,
}: {
  src: string;
  startFrom: number;
  offsetX: number;
  clipDurationInFrames: number;
  sourceAspectRatio?: number | null;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeStartFrame = clipDurationInFrames - Math.round(fps);
  const volume = interpolate(
    frame,
    [fadeStartFrame, clipDurationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Portrait source (aspect ratio < 1, e.g. 9:16): already fills the vertical frame.
  // Landscape source (aspect ratio >= 1 or unknown): scale width so the video fills the
  // full composition height, then center with optional horizontal pan (offsetX).
  const isPortrait = sourceAspectRatio != null && sourceAspectRatio < 1;

  // Width needed (as % of COMP_WIDTH) for a landscape video to fill the composition height:
  //   COMP_HEIGHT * sourceAspectRatio / COMP_WIDTH * 100
  // For 16:9 in 1080×1920 this is ~316%. Fall back to 316% (16:9 assumption) when unknown.
  const landscapeWidthPct =
    sourceAspectRatio != null
      ? (COMP_HEIGHT * sourceAspectRatio / COMP_WIDTH) * 100
      : (COMP_HEIGHT * (16 / 9) / COMP_WIDTH) * 100;

  const videoStyle = isPortrait
    ? {
        width: "100%",
        height: "100%",
        objectFit: "cover" as const,
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

  return (
    <Sequence from={-startFrom}>
      <OffthreadVideo
        src={src}
        volume={volume}
        style={videoStyle}
      />
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
  const { durationInFrames } = useVideoConfig();

  const hasOutro = !!outroSrc && outroDurationInFrames > 0;
  const overlap = hasOutro ? outroOverlapFrames : 0;

  // total duration = clipDuration + outroDuration - overlap
  const clipDurationInFrames = hasOutro
    ? durationInFrames - outroDurationInFrames + overlap
    : durationInFrames;

  // Outro begins overlap frames before the clip ends
  const outroFrom = clipDurationInFrames - overlap;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Main clip: video + captions */}
      <Sequence durationInFrames={clipDurationInFrames}>
        <AbsoluteFill>
          {videoUrl && (
            <ClipVideo
              src={videoUrl}
              startFrom={startFrom}
              offsetX={offsetX}
              clipDurationInFrames={clipDurationInFrames}
              sourceAspectRatio={sourceAspectRatio}
            />
          )}
        </AbsoluteFill>
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
