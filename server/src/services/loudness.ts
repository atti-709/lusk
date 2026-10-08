import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import { getFFmpegPath } from "../config/ffmpeg.js";

const execFileAsync = promisify(execFile);

/**
 * Loudness of a finished short: what Instagram / TikTok / YouTube play speech at, and
 * where the show's own hand-made shorts sit (-14.5 LUFS). Shorts were rendered at
 * whatever level their source had — a quiet review mix (E07's, -33 LUFS) came out
 * barely audible next to the masters (-15.6) and the hot ones (-12, peaks at 0 dBFS).
 */
export const TARGET_LUFS = -14;
/** True-peak ceiling, so the AAC encode and the platforms' own processing don't clip. */
export const TARGET_TRUE_PEAK = -1.5;
/** The ceiling as a linear sample limit for the final limiter, a little under it for the encode. */
const PEAK_LIMIT = (10 ** ((TARGET_TRUE_PEAK - 0.5) / 20)).toFixed(3);
/** Within this of the target (and under the ceiling) a short is left as it is. */
const TOLERANCE_LU = 0.5;

export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** Parse the JSON block `loudnorm=print_format=json` prints at the end of its stderr. */
export function parseLoudnorm(stderr: string): LoudnessMeasure | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const m = JSON.parse(stderr.slice(start, end + 1)) as LoudnessMeasure;
    return Number.isFinite(Number(m.input_i)) ? m : null;
  } catch {
    return null;
  }
}

const filter = (extra = "") =>
  `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=11${extra}`;

/**
 * Write `input` to `output` at the target loudness: ffmpeg's two-pass loudnorm — measure,
 * then a linear gain (it falls back to its gentle dynamic mode only when the gain would
 * push peaks over the ceiling). The video stream is copied. A short with no measurable
 * audio, or one already at the target, is copied unchanged.
 */
export async function normalizeLoudness(input: string, output: string, signal?: AbortSignal): Promise<void> {
  const ffmpeg = getFFmpegPath();
  const { stderr } = await execFileAsync(ffmpeg, [
    "-hide_banner", "-nostats", "-i", input, "-vn", "-af", filter(":print_format=json"), "-f", "null", "-",
  ], { maxBuffer: 16 << 20, signal });
  const m = parseLoudnorm(stderr);
  const level = Number(m?.input_i);
  if (!m || !Number.isFinite(level) || level < -60) {
    await copyFile(input, output);
    return;
  }
  if (Math.abs(level - TARGET_LUFS) <= TOLERANCE_LU && Number(m.input_tp) <= TARGET_TRUE_PEAK) {
    await copyFile(input, output);
    return;
  }
  const measured = `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}`
    + `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await execFileAsync(ffmpeg, [
    "-hide_banner", "-nostats", "-y", "-i", input,
    "-map", "0", "-c:v", "copy",
    // loudnorm's dynamic fallback (a quiet mix with loud peaks) can still overshoot by a dB
    "-af", `${filter(measured)},aresample=48000,alimiter=limit=${PEAK_LIMIT}:level=disabled`,
    "-c:a", "aac", "-b:a", "256k",
    "-movflags", "+faststart",
    output,
  ], { maxBuffer: 16 << 20, signal });
}
