import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getClientPublicDir } from "../config/paths.js";
import { getFFmpegPath } from "../config/ffmpeg.js";
import { bundle } from "@remotion/bundler";
import type { CancelSignal } from "@remotion/renderer";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { CaptionWord } from "@lusk/shared";
import type { Caption } from "@remotion/captions";

const execFileAsync = promisify(execFile);


const COMP_FPS = 23.976;
const COMPOSITION_ID = "LuskClip";
const LUSK_SERVER_ORIGIN =
  process.env.LUSK_SERVER_ORIGIN ?? "http://localhost:3000";
const OUTRO_OVERLAP_FRAMES = 4; // must match VideoComposition.tsx

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
   * Detect outro.mp4 in client/public/ and build an OutroConfig.
   * Returns null if no outro.mp4 is found.
   */
  async detectOutroConfig(): Promise<OutroConfig | null> {
    const outroPath = path.join(this.publicDir, "outro.mp4");
    if (!fs.existsSync(outroPath)) return null;

    const outroDuration = await this.probeDuration(outroPath);
    if (outroDuration <= 0) return null;

    return {
      outroSrc: `${LUSK_SERVER_ORIGIN}/public/outro.mp4`,
      outroDurationInFrames: Math.ceil(outroDuration * COMP_FPS),
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
    clip: { startMs: number; endMs: number },
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

    const startFrame = Math.round((clip.startMs / 1000) * COMP_FPS);
    const actualStartMs = (startFrame / COMP_FPS) * 1000;
    const clipDurationInFrames = Math.max(
      1,
      Math.ceil(((clip.endMs - actualStartMs) / 1000) * COMP_FPS)
    );

    const remotionCaptions: Caption[] =
      preProcessedCaptions ??
      captions
        .filter((c) => c.endMs > clip.startMs && c.startMs < clip.endMs)
        .map((c) => ({
          text: c.text,
          startMs: c.startMs - actualStartMs,
          endMs: c.endMs - actualStartMs,
          timestampMs:
            c.timestampMs != null ? c.timestampMs - actualStartMs : null,
          confidence: c.confidence,
        }));

    const hasOutro = outroConfig != null && outroConfig.outroSrc.length > 0;
    const outroDurationInFrames = hasOutro
      ? outroConfig.outroDurationInFrames
      : 0;
    const overlap = hasOutro ? OUTRO_OVERLAP_FRAMES : 0;

    const inputProps = {
      videoUrl,
      captions: remotionCaptions,
      offsetX,
      startFrom: startFrame,
      outroSrc: hasOutro ? outroConfig.outroSrc : "",
      outroDurationInFrames,
      sourceAspectRatio: sourceAspectRatio ?? null,
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
