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
}: {
  src: string;
  startFrom: number;
  offsetX: number;
  clipDurationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const fadeStartFrame = clipDurationInFrames - Math.round(COMP_FPS);
  const volume = interpolate(
    frame,
    [fadeStartFrame, clipDurationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <Sequence from={-startFrom}>
      <OffthreadVideo
        src={src}
        volume={volume}
        style={{
          width: "177.78%",
          height: "100%",
          objectFit: "cover",
          position: "absolute",
          left: "50%",
          transform: `translateX(calc(-50% + ${offsetX}px))`,
        }}
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
};

export function VideoComposition({
  videoUrl,
  captions,
  offsetX,
  startFrom = 0,
  outroSrc,
  outroDurationInFrames = 0,
}: VideoCompositionProps) {
  const { durationInFrames } = useVideoConfig();

  const hasOutro = !!outroSrc && outroDurationInFrames > 0;
  const overlap = hasOutro ? OUTRO_OVERLAP_FRAMES : 0;

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
            />
          )}
        </AbsoluteFill>
        {captions.length > 0 && <CaptionOverlay captions={captions} />}
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
