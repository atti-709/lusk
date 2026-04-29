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

export type CompSegment = {
  /** Frame in the source video where this segment starts. */
  startFromInFrames: number;
  /** Length of this segment in output frames. */
  durationInFrames: number;
};

function ClipSegmentVideo({
  src,
  startFromInFrames,
  durationInFrames,
  offsetX,
  fadeOut,
  sourceAspectRatio,
}: {
  src: string;
  startFromInFrames: number;
  durationInFrames: number;
  offsetX: number;
  fadeOut: boolean;
  sourceAspectRatio?: number | null;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Audio fades out only at the very end of the clip (last segment).
  const fadeStartFrame = durationInFrames - Math.round(fps);
  const volume = fadeOut
    ? interpolate(
        frame,
        [fadeStartFrame, durationInFrames - 1],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      )
    : 1;

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
  return (
    <Sequence from={-startFromInFrames}>
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
  /** Multi-cut segments (canonical). When absent, falls back to startFrom + the rest of the composition's duration. */
  segments?: CompSegment[];
  /** Legacy single-segment fallback. Used only when segments is empty/undefined. */
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
  segments,
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

  // Resolve segments: explicit list, or a single legacy segment spanning the full clip.
  const effectiveSegments: CompSegment[] =
    segments && segments.length > 0
      ? segments
      : [{ startFromInFrames: startFrom, durationInFrames: clipDurationInFrames }];

  // Compute cumulative output offsets for each segment.
  let runningFrame = 0;
  const segmentLayouts = effectiveSegments.map((seg, i) => {
    const fromFrame = runningFrame;
    runningFrame += seg.durationInFrames;
    return {
      ...seg,
      fromFrame,
      isLast: i === effectiveSegments.length - 1,
    };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Main clip: video segments + captions */}
      <Sequence durationInFrames={clipDurationInFrames}>
        <AbsoluteFill>
          {videoUrl &&
            segmentLayouts.map((seg, i) => (
              <Sequence
                key={i}
                from={seg.fromFrame}
                durationInFrames={seg.durationInFrames}
              >
                <ClipSegmentVideo
                  src={videoUrl}
                  startFromInFrames={seg.startFromInFrames}
                  durationInFrames={seg.durationInFrames}
                  offsetX={offsetX}
                  fadeOut={seg.isLast}
                  sourceAspectRatio={sourceAspectRatio}
                />
              </Sequence>
            ))}
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
