import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { CaptionWord } from "@lusk/shared";
import type { Caption } from "@remotion/captions";

const COMP_FPS = 23.976;
const COMPOSITION_ID = "LuskClip";
const LUSK_SERVER_ORIGIN = "http://localhost:3000";

type ProgressCallback = (percent: number, message: string) => void;

class RenderService {
  private bundlePath: string | null = null;

  private get entryPoint(): string {
    return path.resolve(
      import.meta.dirname,
      "../../../client/src/remotion/index.ts"
    );
  }

  async ensureBundled(onProgress?: ProgressCallback): Promise<string> {
    if (this.bundlePath) return this.bundlePath;

    onProgress?.(5, "Bundling composition...");
    this.bundlePath = await bundle({
      entryPoint: this.entryPoint,
      onProgress: (progress) => {
        onProgress?.(5 + Math.round(progress * 15), "Bundling composition...");
      },
    });
    onProgress?.(20, "Bundle ready");
    return this.bundlePath;
  }

  async renderClip(
    sessionId: string,
    sessionDir: string,
    clip: { startMs: number; endMs: number },
    offsetX: number,
    captions: CaptionWord[],
    onProgress?: ProgressCallback,
    outputFileName: string = "output.mp4"
  ): Promise<string> {
    const serveUrl = await this.ensureBundled(onProgress);
    // Remotion's bundler serves from a temp dir — absolute file paths don't work.
    // Point at the Lusk server's static endpoint instead.
    const videoUrl = `${LUSK_SERVER_ORIGIN}/static/${sessionId}/input.mp4`;
    const outputPath = path.join(sessionDir, outputFileName);

    // Replicate the frame quantization from StudioView
    const startFrame = Math.round((clip.startMs / 1000) * COMP_FPS);
    const actualStartMs = (startFrame / COMP_FPS) * 1000;
    const durationInFrames = Math.max(
      1,
      Math.ceil(((clip.endMs - actualStartMs) / 1000) * COMP_FPS)
    );

    // Filter and shift captions to clip-relative timing
    const remotionCaptions: Caption[] = captions
      .filter((c) => c.endMs > clip.startMs && c.startMs < clip.endMs)
      .map((c) => ({
        text: c.text,
        startMs: c.startMs - actualStartMs,
        endMs: c.endMs - actualStartMs,
        timestampMs:
          c.timestampMs != null ? c.timestampMs - actualStartMs : null,
        confidence: c.confidence,
      }));

    const inputProps = {
      videoUrl,
      captions: remotionCaptions,
      offsetX,
      startFrom: startFrame,
    };

    onProgress?.(20, "Preparing composition...");

    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });

    // Override duration for this specific clip
    composition.durationInFrames = durationInFrames;

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
