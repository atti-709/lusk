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
import type { CaptionWord, ClipSegment } from "@lusk/shared";
import type { Caption } from "@remotion/captions";

type CompSegment = {
  startFromInFrames: number;
  durationInFrames: number;
};

/** Computes per-segment frame layouts using the same rounding rule as legacy single-clip render. */
function computeSegmentLayouts(segments: ClipSegment[], fps: number): {
  layouts: CompSegment[];
  totalDurationInFrames: number;
  /** Per-segment (frame-snapped) start in source ms — used for caption remapping. */
  snappedSourceStartsMs: number[];
} {
  const layouts: CompSegment[] = [];
  const snappedSourceStartsMs: number[] = [];
  let totalDurationInFrames = 0;
  for (const seg of segments) {
    const startFrame = Math.round((seg.startMs / 1000) * fps);
    const snappedStartMs = (startFrame / fps) * 1000;
    const durationInFrames = Math.max(
      1,
      Math.ceil(((seg.endMs - snappedStartMs) / 1000) * fps)
    );
    layouts.push({ startFromInFrames: startFrame, durationInFrames });
    snappedSourceStartsMs.push(snappedStartMs);
    totalDurationInFrames += durationInFrames;
  }
  return { layouts, totalDurationInFrames, snappedSourceStartsMs };
}

/** Remaps a flat list of source captions onto the multi-segment output timeline. Captions are clipped at segment boundaries. */
function remapCaptionsToSegments(
  captions: CaptionWord[],
  segments: ClipSegment[],
  layouts: CompSegment[],
  snappedSourceStartsMs: number[],
  fps: number
): Caption[] {
  const result: Caption[] = [];
  let cumOutputMs = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const snappedStartMs = snappedSourceStartsMs[i];
    const segOutputMs = (layouts[i].durationInFrames / fps) * 1000;
    for (const c of captions) {
      if (c.endMs <= seg.startMs || c.startMs >= seg.endMs) continue;
      const clippedStart = Math.max(c.startMs, seg.startMs);
      const clippedEnd = Math.min(c.endMs, seg.endMs);
      const startMs = clippedStart - snappedStartMs + cumOutputMs;
      const endMs = clippedEnd - snappedStartMs + cumOutputMs;
      const tsMs =
        c.timestampMs != null
          ? Math.min(Math.max(c.timestampMs, clippedStart), clippedEnd) -
            snappedStartMs +
            cumOutputMs
          : null;
      result.push({
        text: c.text,
        startMs,
        endMs,
        timestampMs: tsMs,
        confidence: c.confidence,
      });
    }
    cumOutputMs += segOutputMs;
  }
  return result;
}

const execFileAsync = promisify(execFile);


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
        onProgress?.(5 + Math.round(progress * 15), "Bundling composition...");
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
    clip: { startMs: number; endMs: number; segments?: ClipSegment[] },
    offsetX: number,
    captions: CaptionWord[],
    onProgress?: ProgressCallback,
    outputFileName: string = "output.mp4",
    preProcessedCaptions?: Caption[],
    outroConfig?: OutroConfig | null,
    sourceAspectRatio?: number | null,
    cancelSignal?: CancelSignal
  ): Promise<string> {
    const serveUrl = await this.ensureBundled(onProgress, outroConfig != null);
    const videoUrl = `${LUSK_SERVER_ORIGIN}/static/${sessionId}/input.mp4`;
    const outputPath = path.join(sessionDir, outputFileName);

    const fps = await settingsService.getFps();
    const outroOverlapFrames = await settingsService.getOutroOverlapFrames();
    const captionStyles = await settingsService.getCaptionStyles();

    const segments: ClipSegment[] =
      clip.segments && clip.segments.length > 0
        ? clip.segments
        : [{ startMs: clip.startMs, endMs: clip.endMs }];

    const { layouts, totalDurationInFrames: clipDurationInFrames, snappedSourceStartsMs } =
      computeSegmentLayouts(segments, fps);

    const remotionCaptions: Caption[] =
      preProcessedCaptions ??
      remapCaptionsToSegments(captions, segments, layouts, snappedSourceStartsMs, fps);

    const hasOutro = outroConfig != null && outroConfig.outroSrc.length > 0;
    const outroDurationInFrames = hasOutro
      ? outroConfig.outroDurationInFrames
      : 0;
    const overlap = hasOutro ? outroOverlapFrames : 0;

    const inputProps = {
      videoUrl,
      captions: remotionCaptions,
      offsetX,
      segments: layouts,
      // startFrom kept for older bundled compositions; harmless when segments is set.
      startFrom: layouts[0].startFromInFrames,
      outroSrc: hasOutro ? outroConfig.outroSrc : "",
      outroDurationInFrames,
      outroOverlapFrames,
      sourceAspectRatio: sourceAspectRatio ?? null,
      captionStyles: captionStyles ?? undefined,
    };

    const totalDurationInFrames =
      clipDurationInFrames + outroDurationInFrames - overlap;

    onProgress?.(20, "Preparing composition...");

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
      outputLocation: outputPath,
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

    onProgress?.(95, "Render complete");
    return outputPath;
  }
}

export const renderService = new RenderService();
export { RenderService };
