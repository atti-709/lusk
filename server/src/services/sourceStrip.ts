import type { FitRange, FramingKeyframe } from "@lusk/shared";

/** Output frame of the composition (9:16). */
const COMP_WIDTH = 1080;
const COMP_HEIGHT = 1920;
/** Source pixels kept beyond the crop window on each side, so scaling never samples past the strip. */
const EDGE_PX = 4;
/** A strip this close to the full width isn't worth cutting. */
const MAX_STRIP_FRACTION = 0.9;

export interface SourceStrip {
  /** Left edge, fraction of the source width. */
  x: number;
  /** Width, fraction of the source width. */
  w: number;
  /** The same in source pixels (even, for yuv420p), for ffmpeg's crop. */
  px: { x: number; w: number };
}

/**
 * The horizontal strip of a landscape source a 9:16 render can ever show.
 *
 * Rendering cost is dominated by OffthreadVideo extracting full source frames — a 4K master
 * renders ~3× slower than the strip the crop actually looks at. The camera's crop centers
 * (tracked keyframes, linear between them, or the fixed manual offset) clamped like the
 * composition clamps them bound the strip; the segment is cut to it and the composition
 * places it back inside the full-frame box (`sourceStrip` prop), so the picture is identical.
 *
 * Null when the whole frame is needed: portrait sources, graphics shown whole (`fit`
 * ranges), or a camera that travels across most of the frame.
 */
export function sourceStripFor(
  width: number,
  height: number,
  framing: FramingKeyframe[] | null | undefined,
  offsetX: number,
  fitRanges: FitRange[] | null | undefined,
): SourceStrip | null {
  if (width <= 0 || height <= 0 || width / height <= 9 / 16 + 0.01) return null;
  if (fitRanges && fitRanges.length > 0) return null;

  // As in VideoComposition: the source is scaled to the composition height
  const videoWidth = COMP_HEIGHT * (width / height);
  const half = COMP_WIDTH / 2 / videoWidth; // half the crop window, fraction of source width
  const clamp = (cx: number) => Math.min(1 - half, Math.max(half, cx));
  const centers = framing && framing.length > 0
    ? framing.map((k) => clamp(k.cx))
    : [clamp(0.5 - offsetX / videoWidth)];

  const left = Math.max(0, Math.floor(((Math.min(...centers) - half) * width - EDGE_PX) / 2) * 2);
  const right = Math.min(width, Math.ceil(((Math.max(...centers) + half) * width + EDGE_PX) / 2) * 2);
  const w = right - left;
  if (w >= MAX_STRIP_FRACTION * width) return null;
  return { x: left / width, w: w / width, px: { x: left, w } };
}
