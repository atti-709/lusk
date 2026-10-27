// Summary math for the framing baseline (see framing-baseline.ts). Pure functions, no I/O.

/** One face of `track_speaker.py --debug-faces`; x/y/w/h are fractions of the frame, y from the top. */
export interface DebugFace {
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface DebugFrame {
  t: number;
  faces: DebugFace[];
  text: [number, number][];
}

export interface DebugFaces {
  sampleHz: number;
  detectWidth: number;
  faceMinConfidence: number;
  fitFaceMinH: number;
  frames: DebugFrame[];
}

export type FitRange = [number, number] | [number, number, number, number];

/** Edges of the face-height histogram (fraction of the frame height); the last bin is open-ended. */
export const HEIGHT_BINS = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5];

/** Seconds covered by the union of the fit ranges inside [0, span]. */
export function fitSeconds(fit: FitRange[], span: number): number {
  const spans = fit
    .map((r) => [Math.max(0, r[0]), Math.min(span, r[1])] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    const from = Math.max(a, end);
    if (b > from) total += b - from;
    end = Math.max(end, b);
  }
  return total;
}

export function fitPercent(fit: FitRange[], span: number): number {
  return span > 0 ? (100 * fitSeconds(fit, span)) / span : 0;
}

export function cutsPerMinute(cuts: number[], span: number): number {
  return span > 0 ? cuts.length / (span / 60) : 0;
}

export interface Distribution {
  n: number;
  min: number | null;
  median: number | null;
  max: number | null;
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { n: 0, min: null, median: null, max: null };
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, min: v[0], median, max: v[v.length - 1] };
}

/** Counts per bin of HEIGHT_BINS (bin i = [edge i, edge i+1), the last one open-ended). */
export function histogram(values: number[], edges: number[] = HEIGHT_BINS): number[] {
  const counts = new Array<number>(edges.length).fill(0);
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i--;
    counts[i]++;
  }
  return counts;
}

export interface FaceStats {
  frames: number;
  /** Frames with no face at or above the detector's confidence floor. */
  framesNoFace: number;
  /** Of those, frames where Vision still returned a face below the floor. */
  framesLowConfOnly: number;
  /** Frames whose biggest face is under `fitFaceMinH` (the tracker treats them as nobody). */
  framesBelowFitMin: number;
  /** Height of the biggest confident face per frame. */
  biggest: Distribution;
  biggestHistogram: number[];
  /** Height of every confident face of every frame. */
  all: Distribution;
  allHistogram: number[];
  /** Frames with 3 or more lines of on-screen text. */
  framesTextHeavy: number;
}

export function faceStats(debug: DebugFaces): FaceStats {
  const biggest: number[] = [];
  const all: number[] = [];
  let noFace = 0;
  let lowOnly = 0;
  let belowMin = 0;
  let textHeavy = 0;
  for (const f of debug.frames) {
    const good = f.faces.filter((x) => x.conf >= debug.faceMinConfidence);
    if (f.text.length >= 3) textHeavy++;
    if (good.length === 0) {
      noFace++;
      if (f.faces.length > 0) lowOnly++;
      belowMin++;
      continue;
    }
    const heights = good.map((x) => x.h);
    all.push(...heights);
    const top = Math.max(...heights);
    biggest.push(top);
    if (top < debug.fitFaceMinH) belowMin++;
  }
  return {
    frames: debug.frames.length,
    framesNoFace: noFace,
    framesLowConfOnly: lowOnly,
    framesBelowFitMin: belowMin,
    biggest: distribution(biggest),
    biggestHistogram: histogram(biggest),
    all: distribution(all),
    allHistogram: histogram(all),
    framesTextHeavy: textHeavy,
  };
}

/** Start of each fixed range: minutes 5, 15 and 25, pulled back so the range fits inside the video. */
export function rangeStarts(durationSeconds: number, rangeSeconds = 45, minutes = [5, 15, 25]): number[] {
  const latest = Math.max(0, Math.floor(durationSeconds - rangeSeconds));
  return [...new Set(minutes.map((m) => Math.min(m * 60, latest)))];
}
