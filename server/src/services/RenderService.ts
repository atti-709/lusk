import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getClientPublicDir } from "../config/paths.js";
import { getFFmpegPath } from "../config/ffmpeg.js";
import { settingsService, getConfigDir } from "./SettingsService.js";
import { bundle } from "@remotion/bundler";
import type { CancelSignal } from "@remotion/renderer";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { CaptionWord, FramingKeyframe } from "@lusk/shared";
import { getClipRange } from "@lusk/shared";
import type { Caption } from "@remotion/captions";

/**
 * Computes the frame layout for a single clip range using the render's rounding rule.
 *
 * `sourceDurationMs` caps the range at the end of the source video. Remotion's
 * OffthreadVideo does not fail when asked for a timestamp past the end of a file — it
 * silently hands back the last decoded frame, so an over-long range renders as a frozen
 * tail. `getClipRange` adds CLIP_TRAILING_MARGIN_MS to every clip end and `Math.ceil`
 * adds up to a frame more, so clips near the end of a video overrun by default.
 */
export function computeClipLayout(
  startMs: number,
  endMs: number,
  fps: number,
  sourceDurationMs?: number | null
): {
  startFromInFrames: number;
  durationInFrames: number;
  /** Frame-snapped source start in ms — used for caption remapping. */
  snappedStartMs: number;
} {
  const startFromInFrames = Math.round((startMs / 1000) * fps);
  const snappedStartMs = (startFromInFrames / fps) * 1000;
  let durationInFrames = Math.max(
    1,
    Math.ceil(((endMs - snappedStartMs) / 1000) * fps)
  );

  if (sourceDurationMs != null && sourceDurationMs > 0) {
    // Frame indices run 0..sourceFrames-1, so the clip must end by sourceFrames
    const sourceFrames = Math.floor((sourceDurationMs / 1000) * fps);
    durationInFrames = Math.max(1, Math.min(durationInFrames, sourceFrames - startFromInFrames));
  }

  return { startFromInFrames, durationInFrames, snappedStartMs };
}

/** Remaps source captions onto the clip's output timeline. Captions are clipped at the range boundaries. */
function remapCaptions(
  captions: CaptionWord[],
  startMs: number,
  endMs: number,
  snappedStartMs: number
): Caption[] {
  const result: Caption[] = [];
  for (const c of captions) {
    if (c.endMs <= startMs || c.startMs >= endMs) continue;
    const clippedStart = Math.max(c.startMs, startMs);
    const clippedEnd = Math.min(c.endMs, endMs);
    result.push({
      text: c.text,
      startMs: clippedStart - snappedStartMs,
      endMs: clippedEnd - snappedStartMs,
      timestampMs:
        c.timestampMs != null
          ? Math.min(Math.max(c.timestampMs, clippedStart), clippedEnd) - snappedStartMs
          : null,
      confidence: c.confidence,
    });
  }
  return result;
}

const execFileAsync = promisify(execFile);

/** Extra source kept past the clip end so OffthreadVideo never runs off the segment and freezes. */
const SEGMENT_TAIL_PAD_SEC = 1;
/** Generous ceiling for the segment cut — a cloud-only source must first stream the range in. */
const SEGMENT_CUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Cuts [startSec, startSec + durationSec] out of the source into a short local H.264 file.
 *
 * Remotion downloads every http asset in full before it can extract a single frame, and
 * input.mp4 is usually a symlink into Google Drive / iCloud. Handing it the whole source
 * meant streaming a 1-1.5 GB cloud-only file per render (subject to Remotion's 20s
 * no-data and 120s delayRender timeouts) — renders stalled at "Rendering video...".
 * ffmpeg seeks with range reads, so only the clip's bytes are fetched.
 *
 * Input-side `-ss` with a re-encode is frame-accurate: segment time t matches source time startSec + t.
 */
async function cutSourceSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
  cancelSignal?: CancelSignal
): Promise<void> {
  const controller = new AbortController();
  cancelSignal?.(() => controller.abort());
  try {
    await execFileAsync(
      getFFmpegPath(),
      [
        "-v", "error",
        "-y",
        "-hwaccel", "videotoolbox", // falls back to software decode if unsupported
        "-ss", startSec.toFixed(6),
        "-i", inputPath,
        "-t", durationSec.toFixed(6),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "14",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "256k",
        "-movflags", "+faststart",
        outputPath,
      ],
      { signal: controller.signal, timeout: SEGMENT_CUT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (err) {
    fs.rmSync(outputPath, { force: true });
    if (controller.signal.aborted) throw new Error("Render cancelled");
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const killed = (err as { killed?: boolean }).killed;
    throw new Error(
      killed
        ? `Timed out reading the source video (is it a cloud file that couldn't be downloaded?)`
        : `Failed to cut source segment: ${stderr || (err as Error).message}`
    );
  }
}


const COMPOSITION_ID = "LuskClip";
const LUSK_SERVER_ORIGIN =
  process.env.LUSK_SERVER_ORIGIN ?? "http://localhost:3000";

type ProgressCallback = (percent: number, message: string) => void;

export interface OutroConfig {
  outroSrc: string;
  outroDurationInFrames: number;
}

class RenderService {
  private bundlePath: string | null = null;
  private bundledWithOutro: boolean | null = null; // tracks public dir state at bundle time

  private get entryPoint(): string {
    return (
      process.env.LUSK_REMOTION_ENTRY ??
      path.resolve(import.meta.dirname, "../../../client/src/remotion/index.ts")
    );
  }

  private get publicDir(): string {
    return getClientPublicDir();
  }

  /**
   * Probe a video/audio file's duration in seconds.
   * Tries ffprobe first, falls back to parsing ffmpeg stderr output.
   */
  async probeDuration(filePath: string): Promise<number> {
    // Try ffprobe
    try {
      const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
      const { stdout } = await execFileAsync(ffprobe, [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        filePath,
      ]);
      const dur = parseFloat(JSON.parse(stdout).format?.duration ?? "0");
      if (dur > 0) return dur;
    } catch { /* ffprobe not available */ }

    // Fallback: use ffmpeg -i (resolves bundled ffmpeg-static binary)
    try {
      const ffmpeg = getFFmpegPath();
      const result = await execFileAsync(ffmpeg, ["-i", filePath])
        .catch((e: { stderr?: string }) => e);
      const text = (result as { stderr?: string }).stderr ?? "";
      const m = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (m) {
        return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      }
    } catch { /* ignore */ }

    return 0;
  }

  /**
   * Detect outro.mp4 — checks ~/.lusk/outro.mp4 first, then client/public/outro.mp4.
   * Returns null if no outro.mp4 is found.
   */
  async detectOutroConfig(): Promise<OutroConfig | null> {
    const globalOutro = path.join(getConfigDir(), "outro.mp4");
    const bundledOutro = path.join(this.publicDir, "outro.mp4");

    let outroPath: string;
    let urlPrefix: string;

    if (fs.existsSync(globalOutro)) {
      outroPath = globalOutro;
      urlPrefix = "/config-assets/";
    } else if (fs.existsSync(bundledOutro)) {
      outroPath = bundledOutro;
      urlPrefix = "/public/";
    } else {
      return null;
    }

    const outroDuration = await this.probeDuration(outroPath);
    if (outroDuration <= 0) return null;

    const fps = await settingsService.getFps();

    return {
      outroSrc: `${LUSK_SERVER_ORIGIN}${urlPrefix}outro.mp4`,
      outroDurationInFrames: Math.ceil(outroDuration * fps),
    };
  }

  async ensureBundled(onProgress?: ProgressCallback, outroPresent?: boolean): Promise<string> {
    // Invalidate the cached bundle if the outro presence changed since last bundle
    if (this.bundlePath && outroPresent !== undefined && outroPresent !== this.bundledWithOutro) {
      this.bundlePath = null;
    }

    if (this.bundlePath) return this.bundlePath;

    this.bundledWithOutro = outroPresent ?? false;
    onProgress?.(5, "Bundling composition...");

    // Resolve modules from both server and client node_modules.
    // In packaged app: bundle/server/node_modules has Remotion/React,
    // bundle/client/node_modules has @remotion/captions, @remotion/google-fonts, etc.
    const serverNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    const clientNodeModules = path.resolve(
      this.entryPoint, "../../..", "node_modules"
    );

    this.bundlePath = await bundle({
      entryPoint: this.entryPoint,
      publicDir: this.publicDir,
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: ["node_modules", serverNodeModules, clientNodeModules],
        },
      }),
      onProgress: (progress) => {
        // Remotion reports bundling progress as 0-100
        onProgress?.(5 + Math.round((progress / 100) * 15), "Bundling composition...");
      },
    });
    onProgress?.(20, "Bundle ready");
    return this.bundlePath;
  }

  /**
   * Force re-bundle on next render (call after assets in public/ change).
   */
  invalidateBundle(): void {
    this.bundlePath = null;
    this.bundledWithOutro = null;
  }

  async renderClip(
    sessionId: string,
    sessionDir: string,
    clip: Parameters<typeof getClipRange>[0],
    offsetX: number,
    captions: CaptionWord[],
    onProgress?: ProgressCallback,
    outputFileName: string = "output.mp4",
    preProcessedCaptions?: Caption[],
    outroConfig?: OutroConfig | null,
    sourceAspectRatio?: number | null,
    cancelSignal?: CancelSignal,
    framing?: FramingKeyframe[] | null,
    fitRanges?: [number, number][] | null
  ): Promise<string> {
    const serveUrl = await this.ensureBundled(onProgress, outroConfig != null);
    const segmentFileName = `source_${outputFileName}`;
    const videoUrl = `${LUSK_SERVER_ORIGIN}/static/${sessionId}/${segmentFileName}`;
    const segmentPath = path.join(sessionDir, segmentFileName);
    const outputPath = path.join(sessionDir, outputFileName);
    // Render beside the target and move it into place only when complete: a cancelled or
    // failed render must not leave a truncated file — or clobber an earlier good export
    const partialPath = `${outputPath}.partial.mp4`;

    const fps = await settingsService.getFps();
    const outroOverlapFrames = await settingsService.getOutroOverlapFrames();
    const captionStyles = await settingsService.getCaptionStyles();

    const { startMs, endMs } = getClipRange(clip);
    // Probe rather than trust the session: the clip range carries a trailing margin and
    // user trims, neither of which is bounded by the video's actual length.
    const sourceDurationSec = await this.probeDuration(path.join(sessionDir, "input.mp4"));
    const sourceDurationMs = sourceDurationSec > 0 ? sourceDurationSec * 1000 : null;
    const { durationInFrames: clipDurationInFrames, snappedStartMs } =
      computeClipLayout(startMs, endMs, fps, sourceDurationMs);

    const remotionCaptions: Caption[] =
      preProcessedCaptions ??
      remapCaptions(captions, startMs, endMs, snappedStartMs);

    const hasOutro = outroConfig != null && outroConfig.outroSrc.length > 0;
    const outroDurationInFrames = hasOutro
      ? outroConfig.outroDurationInFrames
      : 0;
    const overlap = hasOutro ? outroOverlapFrames : 0;

    onProgress?.(20, "Reading source video...");
    await cutSourceSegment(
      path.join(sessionDir, "input.mp4"),
      segmentPath,
      snappedStartMs / 1000,
      clipDurationInFrames / fps + SEGMENT_TAIL_PAD_SEC,
      cancelSignal
    );

    try {
      const inputProps = {
        videoUrl,
        captions: remotionCaptions,
        offsetX,
        // The segment already starts at the clip start
        startFrom: 0,
        outroSrc: hasOutro ? outroConfig.outroSrc : "",
        outroDurationInFrames,
        outroOverlapFrames,
        sourceAspectRatio: sourceAspectRatio ?? null,
        captionStyles: captionStyles ?? undefined,
        framing: framing ?? null,
        fitRanges: fitRanges ?? null,
      };

      const totalDurationInFrames =
        clipDurationInFrames + outroDurationInFrames - overlap;

      onProgress?.(22, "Preparing composition...");

      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
      });

      composition.durationInFrames = totalDurationInFrames;

      onProgress?.(25, "Rendering video...");

      const renderOptions = {
        composition,
        serveUrl,
        codec: "h264" as const,
        videoBitrate: "6000k",
        hardwareAcceleration: "if-possible" as const,
        outputLocation: partialPath,
        inputProps,
        timeoutInMilliseconds: 120_000,
        onProgress: ({ progress }: { progress: number }) => {
          const pct = 25 + Math.round(progress * 70);
          onProgress?.(pct, "Rendering video...");
        },
      };
      await renderMedia(
        cancelSignal
          ? { ...renderOptions, cancelSignal }
          : renderOptions
      );

      fs.renameSync(partialPath, outputPath);
      onProgress?.(95, "Render complete");
      return outputPath;
    } finally {
      fs.rmSync(segmentPath, { force: true });
      fs.rmSync(partialPath, { force: true });
    }
  }
}

export const renderService = new RenderService();
export { RenderService };
