import {
  AbsoluteFill,
  Audio,
  Sequence,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Caption } from "@remotion/captions";
import { CaptionOverlay } from "./CaptionOverlay";
import type { CaptionStyles, FramingKeyframe } from "@lusk/shared";
import { framingCenterAt } from "@lusk/shared";

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
  fit,
  sourceStrip,
}: {
  src: string;
  startFromInFrames: number;
  offsetX: number;
  sourceAspectRatio?: number | null;
  /** Show the whole landscape frame, fitted to the width, instead of the 9:16 crop. */
  fit?: boolean;
  sourceStrip?: SourceStrip | null;
}) {
  const isPortrait = sourceAspectRatio != null && sourceAspectRatio < 1;
  const landscapeWidthPct =
    sourceAspectRatio != null
      ? (COMP_HEIGHT * sourceAspectRatio / COMP_WIDTH) * 100
      : (COMP_HEIGHT * (16 / 9) / COMP_WIDTH) * 100;

  const fitHeight = COMP_WIDTH / (sourceAspectRatio ?? 16 / 9);
  const videoStyle = isPortrait
    ? {
        width: "100%",
        height: "100%",
        objectFit: "contain" as const,
        position: "absolute" as const,
        left: 0,
        top: 0,
      }
    : fit
    ? {
        width: COMP_WIDTH,
        height: fitHeight,
        position: "absolute" as const,
        left: 0,
        top: (COMP_HEIGHT - fitHeight) / 2,
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
  if (sourceStrip && !isPortrait && !fit) {
    // The video holds only a strip of the source: the full-frame box is laid out as
    // before and the strip sits at its own place inside it
    return (
      <Sequence from={-startFromInFrames}>
        <div style={videoStyle}>
          <OffthreadVideo
            src={src}
            muted
            style={{
              position: "absolute",
              top: 0,
              height: "100%",
              left: `${sourceStrip.x * 100}%`,
              width: `${sourceStrip.w * 100}%`,
              objectFit: "fill",
            }}
          />
        </div>
      </Sequence>
    );
  }
  return (
    <Sequence from={-startFromInFrames}>
      <OffthreadVideo src={src} muted style={videoStyle} />
    </Sequence>
  );
}

/**
 * Behind a graphic shown whole: the same frame filling 9:16, blurred and darkened, so the
 * bands above and below the fitted picture aren't flat black. Mounted only for the fit
 * stretch, and timed like the main video (`startFromInFrames` is the clip's source start).
 */
function FitBackdrop({
  src,
  startFromInFrames,
  fromFrame,
  sourceAspectRatio,
}: {
  src: string;
  startFromInFrames: number;
  fromFrame: number;
  sourceAspectRatio?: number | null;
}) {
  const widthPct = (COMP_HEIGHT * (sourceAspectRatio ?? 16 / 9) / COMP_WIDTH) * 100;
  return (
    <Sequence from={-(startFromInFrames + fromFrame)}>
      <OffthreadVideo
        src={src}
        muted
        style={{
          width: `${widthPct}%`,
          height: "100%",
          objectFit: "cover",
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%) scale(1.15)",
          filter: "blur(36px) brightness(0.45)",
        }}
      />
    </Sequence>
  );
}

/** Horizontal shift (composition px) that puts the crop center at `cx` (fraction of source width). */
function offsetForCenter(cx: number, sourceAspectRatio: number | null | undefined): number {
  const videoWidth = COMP_HEIGHT * (sourceAspectRatio ?? 16 / 9);
  const maxShift = Math.max(0, (videoWidth - COMP_WIDTH) / 2);
  return Math.max(-maxShift, Math.min(maxShift, (0.5 - cx) * videoWidth));
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
  /** Tracked camera path for the clip (t = seconds from the clip start); overrides offsetX. */
  framing?: FramingKeyframe[] | null;
  /** Graphic stretches (seconds from the clip start) to show whole instead of cropped. */
  fitRanges?: [number, number][] | null;
  /**
   * The video holds only this horizontal strip of the source (renders cut it to what the
   * crop can show — far fewer pixels to extract per frame). Never set with `fitRanges`.
   */
  sourceStrip?: SourceStrip | null;
};

/** A horizontal strip of the source, as fractions of its width. */
export type SourceStrip = { x: number; w: number };

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
  framing,
  fitRanges,
  sourceStrip,
}: VideoCompositionProps) {
  const { durationInFrames, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const cropOffsetX = framing && framing.length > 0
    ? offsetForCenter(framingCenterAt(framing, frame / fps), sourceAspectRatio)
    : offsetX;
  const isLandscape = sourceAspectRatio == null || sourceAspectRatio > 9 / 16 + 0.01;
  const fits = isLandscape ? (fitRanges ?? []) : [];
  const inFit = fits.some(([a, b]) => frame >= a * fps && frame < b * fps);

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
          {videoUrl && fits.map(([a, b]) => {
            const from = Math.round(a * fps);
            return (
              <Sequence key={a} from={from} durationInFrames={Math.max(1, Math.round(b * fps) - from)}>
                <FitBackdrop
                  src={videoUrl}
                  startFromInFrames={startFrom}
                  fromFrame={from}
                  sourceAspectRatio={sourceAspectRatio}
                />
              </Sequence>
            );
          })}
          {videoUrl && (
            <ClipVideo
              fit={inFit}
              src={videoUrl}
              startFromInFrames={startFrom}
              offsetX={cropOffsetX}
              sourceAspectRatio={sourceAspectRatio}
              sourceStrip={sourceStrip}
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
