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

/** Frames over which audio crossfades between adjacent segments (~167ms at 23.976fps). */
export const SEGMENT_AUDIO_CROSSFADE_FRAMES = 4;

export type CompSegment = {
  /** Frame in the source video where this segment starts. */
  startFromInFrames: number;
  /** Length of this segment in output frames. */
  durationInFrames: number;
};

function ClipSegmentVideoOnly({
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
  // muted=true: audio is rendered separately via <Audio> so we can crossfade between segments.
  return (
    <Sequence from={-startFromInFrames}>
      <OffthreadVideo
        src={src}
        muted
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
  const { durationInFrames, fps } = useVideoConfig();

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

  // Compute cumulative output offsets for each segment (back-to-back, no visual overlap).
  let runningFrame = 0;
  const segmentLayouts = effectiveSegments.map((seg, i) => {
    const fromFrame = runningFrame;
    runningFrame += seg.durationInFrames;
    return {
      ...seg,
      fromFrame,
      isFirst: i === 0,
      isLast: i === effectiveSegments.length - 1,
    };
  });

  // Audio crossfade is disabled for single-segment clips (no boundaries to smooth).
  const isMultiSegment = segmentLayouts.length > 1;
  const cf = isMultiSegment ? SEGMENT_AUDIO_CROSSFADE_FRAMES : 0;
  const finalFadeFrames = Math.round(fps); // 1-second fade-to-zero at the end of the last segment

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Main clip: video segments + captions */}
      <Sequence durationInFrames={clipDurationInFrames}>
        <AbsoluteFill>
          {videoUrl &&
            segmentLayouts.map((seg, i) => (
              <Sequence
                key={`v${i}`}
                from={seg.fromFrame}
                durationInFrames={seg.durationInFrames}
              >
                <ClipSegmentVideoOnly
                  src={videoUrl}
                  startFromInFrames={seg.startFromInFrames}
                  offsetX={offsetX}
                  sourceAspectRatio={sourceAspectRatio}
                />
              </Sequence>
            ))}
        </AbsoluteFill>

        {/* Audio segments — non-last segments extend `cf` frames past their video to crossfade with the next. */}
        {videoUrl &&
          segmentLayouts.map((seg, i) => {
            // Tail extension that overlaps with the next segment's audio start.
            const tail = seg.isLast ? 0 : cf;
            const audioDur = seg.durationInFrames + tail;
            const fadeInEnd = seg.isFirst ? 0 : cf;
            const tailStart = seg.durationInFrames; // where this segment's video ends
            const finalFadeStart = seg.durationInFrames - finalFadeFrames;

            return (
              <Sequence
                key={`a${i}`}
                from={seg.fromFrame}
                durationInFrames={audioDur}
              >
                <Audio
                  src={videoUrl}
                  startFrom={seg.startFromInFrames}
                  endAt={seg.startFromInFrames + audioDur}
                  volume={(frame) => {
                    // Fade-in (multi-segment, non-first segments only).
                    if (fadeInEnd > 0 && frame < fadeInEnd) {
                      return frame / fadeInEnd;
                    }
                    // Last segment: 1-second fade-to-zero at the very end of the clip.
                    if (seg.isLast) {
                      if (frame >= finalFadeStart) {
                        return Math.max(0, 1 - (frame - finalFadeStart) / finalFadeFrames);
                      }
                      return 1;
                    }
                    // Non-last segment: crossfade-out tail extending past video end.
                    if (frame >= tailStart) {
                      return Math.max(0, 1 - (frame - tailStart) / cf);
                    }
                    return 1;
                  }}
                />
              </Sequence>
            );
          })}

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
