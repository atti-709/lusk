import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { access, readFile, unlink, readdir } from "node:fs/promises";
import type { TranscriptData, TranscriptWord, CaptionWord } from "@lusk/shared";

const WHISPERX_MODEL = "large-v3-turbo";

export interface TranscriptionResult {
  transcript: TranscriptData;
  captions: CaptionWord[];
}

type ProgressCallback = (percent: number, message: string) => void;

interface WhisperXWord {
  word: string;
  start?: number; // seconds — may be absent if alignment fails
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
  /**
   * Verify that whisperx is reachable via `python3 -m whisperx`.
   */
  private async ensureInstalled(onProgress?: ProgressCallback): Promise<void> {
    onProgress?.(2, "Checking WhisperX...");

    try {
      execSync("python3 -m whisperx --version", { stdio: "pipe" });
    } catch {
      throw new Error(
        "WhisperX is not installed. Run: pip3 install whisperx"
      );
    }

    onProgress?.(5, "WhisperX ready");
  }

  async extractAudio(
    inputPath: string,
    outputPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    onProgress?.(1, "Extracting audio...");
    await access(inputPath);

    execSync(
      `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}" -y`,
      { stdio: "pipe" }
    );

    onProgress?.(5, "Audio extracted");
  }

  /**
   * Run WhisperX CLI: transcribe + forced alignment in one pass.
   * Produces a JSON file with word-level timestamps from wav2vec2.
   */
  private async runWhisperX(
    audioPath: string,
    outputDir: string,
    onProgress?: ProgressCallback
  ): Promise<WhisperXOutput> {
    return new Promise<WhisperXOutput>((resolve, reject) => {
      const args = [
        "-m", "whisperx",
        audioPath,
        "--model", WHISPERX_MODEL,
        "--language", "sk",
        "--compute_type", "int8",
        "--output_format", "json",
        "--output_dir", outputDir,
        "--print_progress", "True",
      ];

      const proc = spawn("python3", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        // WhisperX logs progress as percentage lines
        const lines = stderr.split("\n");
        for (const line of lines) {
          const match = /(\d+)%\|/.exec(line);
          if (match) {
            const pct = 10 + Math.round(parseInt(match[1]) * 0.8);
            onProgress?.(pct, "Transcribing & aligning...");
          }
        }
      });

      proc.on("close", async (code) => {
        if (code !== 0) {
          return reject(
            new Error(`whisperx exited with code ${code}: ${stderr.slice(-500)}`)
          );
        }

        try {
          // WhisperX names the output after the input filename stem
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
    onProgress?: ProgressCallback
  ): Promise<TranscriptionResult> {
    const inputVideo = path.join(sessionDir, "input.mp4");
    const audioWav = path.join(sessionDir, "audio.wav");

    // Step 1: Extract audio
    await this.extractAudio(inputVideo, audioWav, onProgress);

    // Step 2: Ensure WhisperX is available
    await this.ensureInstalled(onProgress);

    // Step 3: Run WhisperX (transcription + forced alignment)
    onProgress?.(10, "Starting WhisperX...");
    const whisperXOutput = await this.runWhisperX(audioWav, sessionDir, onProgress);

    onProgress?.(96, "Processing results...");

    // Step 4: Extract word-level data from WhisperX segments.
    // WhisperX uses wav2vec2 forced alignment — timestamps are tight and accurate.
    // Words missing alignment data (start/end undefined) are interpolated.
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

    // Interpolate any words that fell back to segment boundaries
    // (they'll have identical start/end as their segment, which looks wrong)
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
   * These words have start/end set to their segment boundaries.
   * We distribute them evenly between their aligned neighbours.
   */
  private interpolateMissingTimestamps(words: TranscriptWord[]): void {
    for (let i = 0; i < words.length; i++) {
      if (words[i].startMs === words[i].endMs && i > 0) {
        // Find next word with a real timestamp
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
