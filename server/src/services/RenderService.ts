import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { CaptionWord } from "@lusk/shared";
import type { Caption } from "@remotion/captions";

const execFileAsync = promisify(execFile);

const COMP_FPS = 23.976;
const COMPOSITION_ID = "LuskClip";
const LUSK_SERVER_ORIGIN = "http://localhost:3000";
const OUTRO_OVERLAP_FRAMES = 4; // must match VideoComposition.tsx

type ProgressCallback = (percent: number, message: string) => void;

export interface OutroConfig {
  outroSrc: string;
  outroDurationInFrames: number;
}

class RenderService {
  private bundlePath: string | null = null;

  private get entryPoint(): string {
    return path.resolve(
      import.meta.dirname,
      "../../../client/src/remotion/index.ts"
    );
  }

  private get publicDir(): string {
    return path.resolve(import.meta.dirname, "../../../client/public");
  }

  /**
   * Probe a video/audio file's duration in seconds using ffprobe.
   * Returns 0 if ffprobe fails or the file doesn't exist.
   */
  async probeDuration(filePath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        filePath,
      ]);
      const info = JSON.parse(stdout);
      return parseFloat(info.format?.duration ?? "0");
    } catch {
      return 0;
    }
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
      outroSrc: "/outro.mp4",
      outroDurationInFrames: Math.ceil(outroDuration * COMP_FPS),
    };
  }

  async ensureBundled(onProgress?: ProgressCallback): Promise<string> {
    if (this.bundlePath) return this.bundlePath;

    onProgress?.(5, "Bundling composition...");
    this.bundlePath = await bundle({
      entryPoint: this.entryPoint,
      publicDir: this.publicDir,
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
    outroConfig?: OutroConfig | null
  ): Promise<string> {
    const serveUrl = await this.ensureBundled(onProgress);
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

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      videoBitrate: "6000k",
      hardwareAcceleration: "if-possible",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        const pct = 25 + Math.round(progress * 70);
        onProgress?.(pct, "Rendering video...");
      },
    });

    onProgress?.(95, "Render complete");
    return outputPath;
  }
}

export const renderService = new RenderService();
export { RenderService };
