import path from "node:path";
import fs from "node:fs";
import { execSync, execFileSync, spawn } from "node:child_process";
import { access, readFile, unlink } from "node:fs/promises";
import type { TranscriptData, TranscriptWord, CaptionWord } from "@lusk/shared";
import { getFFmpegPath } from "../config/ffmpeg.js";
import { settingsService } from "./SettingsService.js";

const WHISPERX_MODEL = "large-v3-turbo";

export interface TranscriptionResult {
  transcript: TranscriptData;
  captions: CaptionWord[];
}

type ProgressCallback = (percent: number, message: string) => void;

interface WhisperXWord {
  word: string;
  start?: number;
  end?: number;
  score?: number;
}

interface WhisperXSegment {
  start: number;
  end: number;
  text: string;
  words: WhisperXWord[];
}

interface WhisperXOutput {
  segments: WhisperXSegment[];
}

class WhisperService {
  private _availableCache: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this._availableCache !== null) return this._availableCache;
    const python3 = this.resolvePython3();
    try {
      execFileSync(python3, ["-m", "whisperx", "--version"], { stdio: "pipe" });
      this._availableCache = true;
    } catch {
      this._availableCache = false;
    }
    return this._availableCache;
  }

  /**
   * Resolve the correct python3 binary using the login shell.
   * In packaged macOS apps, the raw PATH may point to the system Python
   * which doesn't have whisperx installed.
   */
  private resolvePython3(): string {
    const shell = process.env.SHELL ?? "/bin/zsh";
    try {
      const resolved = execSync(`${shell} -lc "which python3"`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch { /* fall through */ }
    return "python3";
  }

  private async ensureInstalled(onProgress?: ProgressCallback): Promise<string> {
    onProgress?.(2, "Checking WhisperX...");

    const python3 = this.resolvePython3();

    try {
      execFileSync(python3, ["-m", "whisperx", "--version"], { stdio: "pipe" });
    } catch {
      throw new Error(
        `WhisperX is not installed. Run: pip3 install whisperx (python3: ${python3})`
      );
    }

    onProgress?.(5, "WhisperX ready");
    return python3;
  }

  async extractAudio(
    inputPath: string,
    outputPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    onProgress?.(1, "Extracting audio...");
    await access(inputPath);

    const ffmpeg = getFFmpegPath();

    // Pre-flight: verify the ffmpeg binary exists when an absolute path is given
    if (path.isAbsolute(ffmpeg) && !fs.existsSync(ffmpeg)) {
      throw new Error(
        `ffmpeg binary not found at FFMPEG_PATH: ${ffmpeg}`
      );
    }

    try {
      execFileSync(ffmpeg, [
        "-i", inputPath,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        outputPath,
        "-y",
      ], { stdio: "pipe" });
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? "";
      throw new Error(
        `ffmpeg audio extraction failed (binary: ${ffmpeg}): ${stderr || err.message}`
      );
    }

    onProgress?.(5, "Audio extracted");
  }

  /**
   * Run WhisperX CLI: transcribe + forced alignment in one pass.
   * Produces a JSON file with word-level timestamps from wav2vec2.
   */
  private async runWhisperX(
    audioPath: string,
    outputDir: string,
    python3: string,
    ffmpegPath: string,
    language: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<WhisperXOutput> {
    return new Promise<WhisperXOutput>((resolve, reject) => {
      const args = [
        "-m", "whisperx",
        audioPath,
        "--model", WHISPERX_MODEL,
        "--language", language,
        "--compute_type", "int8",
        "--output_format", "json",
        "--output_dir", outputDir,
        "--print_progress", "True",
      ];

      // Prepend ffmpeg's directory to PATH so WhisperX can find it
      const ffmpegDir = path.dirname(ffmpegPath);
      const envPath = process.env.PATH ? `${ffmpegDir}:${process.env.PATH}` : ffmpegDir;

      if (signal?.aborted) {
        return reject(new Error("Transcription cancelled"));
      }

      const proc = spawn(python3, ["-u", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1", PATH: envPath },
      });

      const onAbort = () => {
        proc.kill("SIGTERM");
        reject(new Error("Transcription cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let partialErr = "";
      let partialOut = "";
      let lastStderr = "";

      const parseProgress = (text: string, partial: string): string => {
        const combined = partial + text;
        const parts = combined.split(/[\r\n]/);
        const remaining = parts.pop() ?? "";

        for (const line of parts) {
          const pctMatch = /(\d+)%\|/.exec(line);
          if (pctMatch) {
            const pct = 10 + Math.round(parseInt(pctMatch[1]) * 0.8);
            onProgress?.(pct, "Transcribing & aligning...");
          }
        }
        return remaining;
      };

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        lastStderr = (lastStderr + text).slice(-500);
        partialErr = parseProgress(text, partialErr);
      });

      proc.stdout.on("data", (chunk: Buffer) => {
        partialOut = parseProgress(chunk.toString(), partialOut);
      });

      proc.on("close", async (code) => {
        signal?.removeEventListener("abort", onAbort);

        for (const buf of [partialErr, partialOut]) {
          const m = /(\d+)%\|/.exec(buf);
          if (m) {
            const pct = 10 + Math.round(parseInt(m[1]) * 0.8);
            onProgress?.(pct, "Transcribing & aligning...");
          }
        }

        if (signal?.aborted) return; // already rejected by onAbort

        if (code !== 0) {
          return reject(
            new Error(`whisperx exited with code ${code}: ${lastStderr}`)
          );
        }

        try {
          const stem = path.basename(audioPath, path.extname(audioPath));
          const jsonPath = path.join(outputDir, `${stem}.json`);
          const raw = await readFile(jsonPath, "utf-8");
          const parsed: WhisperXOutput = JSON.parse(raw);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse WhisperX JSON: ${err}`));
        }
      });

      proc.on("error", reject);
    });
  }

  async transcribe(
    sessionDir: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    const inputVideo = path.join(sessionDir, "input.mp4");
    const audioWav = path.join(sessionDir, "audio.wav");

    // Step 1: Extract audio
    await this.extractAudio(inputVideo, audioWav, onProgress);
    if (signal?.aborted) throw new Error("Transcription cancelled");

    // Resolve the ffmpeg binary path so WhisperX can find it
    const ffmpegPath = getFFmpegPath();

    // Step 2: Ensure WhisperX is available
    const python3 = await this.ensureInstalled(onProgress);
    if (signal?.aborted) throw new Error("Transcription cancelled");

    // Step 3: Run WhisperX (transcription + forced alignment)
    const language = await settingsService.getTranscriptionLanguage();
    onProgress?.(10, "Starting WhisperX...");
    const whisperXOutput = await this.runWhisperX(audioWav, sessionDir, python3, ffmpegPath, language, onProgress, signal);

    onProgress?.(96, "Processing results...");

    // Step 4: Extract word-level data from WhisperX segments.
    const words: TranscriptWord[] = [];

    for (const segment of whisperXOutput.segments) {
      if (!segment.words?.length) continue;

      for (const w of segment.words) {
        const startSec = w.start ?? segment.start;
        const endSec = w.end ?? segment.end;

        words.push({
          word: w.word.trim(),
          startMs: Math.round(startSec * 1000),
          endMs: Math.round(endSec * 1000),
        });
      }
    }

    this.interpolateMissingTimestamps(words);

    const captions: CaptionWord[] = words.map((w, i) => ({
      text: i === 0 ? w.word : ` ${w.word}`,
      startMs: w.startMs,
      endMs: w.endMs,
      timestampMs: w.startMs,
      confidence: null,
    }));

    const transcript: TranscriptData = {
      text: words.map((w) => w.word).join(" "),
      words,
    };

    // Clean up temp files
    const stem = "audio";
    const cleanupFiles = [
      `${stem}.wav`,
      `${stem}.json`,
    ].map((f) => unlink(path.join(sessionDir, f)).catch(() => {}));
    await Promise.all(cleanupFiles);

    onProgress?.(100, "Transcription complete");

    return { transcript, captions };
  }

  /**
   * Fill in timestamps for words where alignment failed.
   */
  private interpolateMissingTimestamps(words: TranscriptWord[]): void {
    for (let i = 0; i < words.length; i++) {
      if (words[i].startMs === words[i].endMs && i > 0) {
        let nextAligned = i + 1;
        while (
          nextAligned < words.length &&
          words[nextAligned].startMs === words[nextAligned].endMs
        ) {
          nextAligned++;
        }

        const prevEnd = words[i - 1].endMs;
        const nextStart =
          nextAligned < words.length
            ? words[nextAligned].startMs
            : prevEnd + (nextAligned - i + 1) * 300;

        const count = nextAligned - i;
        const step = (nextStart - prevEnd) / (count + 1);

        for (let j = 0; j < count; j++) {
          const idx = i + j;
          words[idx].startMs = Math.round(prevEnd + step * (j + 1));
          words[idx].endMs = Math.round(prevEnd + step * (j + 2));
        }
      }
    }
  }
}

export const whisperService = new WhisperService();
export { WhisperService };
