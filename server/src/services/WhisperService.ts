import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { access, writeFile, readFile } from "node:fs/promises";
import {
  installWhisperCpp,
  downloadWhisperModel,
} from "@remotion/install-whisper-cpp";
import type { TranscriptData, TranscriptWord, CaptionWord } from "@lusk/shared";

const WHISPER_CPP_VERSION = "1.8.3";
const MODEL = "large-v3-turbo";

// Whisper's cross-attention alignment fires slightly before speech onset.
// This offset (ms) shifts all word timestamps forward to better match
// the perceived moment the word is spoken.
const TIMING_OFFSET_MS = 60;

export interface TranscriptionResult {
  transcript: TranscriptData;
  captions: CaptionWord[];
}

type ProgressCallback = (percent: number, message: string) => void;

interface WhisperToken {
  text: string;
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  id: number;
  p: number; // probability
}

/** Shape of one segment in whisper-cli's --output-json-full */
interface WhisperJsonSegment {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
  tokens: WhisperToken[];
}

interface WhisperJsonOutput {
  transcription: WhisperJsonSegment[];
}

class WhisperService {
  private whisperPath: string;

  constructor(whisperPath?: string) {
    this.whisperPath =
      whisperPath ?? path.join(import.meta.dirname, "../../whisper.cpp");
  }

  async ensureInstalled(onProgress?: ProgressCallback): Promise<void> {
    const { alreadyExisted } = await installWhisperCpp({
      to: this.whisperPath,
      version: WHISPER_CPP_VERSION,
      printOutput: false,
    });

    if (!alreadyExisted) {
      onProgress?.(8, "Compiled whisper.cpp binary");
    }

    const { alreadyExisted: modelExisted } = await downloadWhisperModel({
      model: MODEL,
      folder: this.whisperPath,
      printOutput: false,
      onProgress: (downloaded, total) => {
        if (total > 0) {
          const pct = 8 + Math.round((downloaded / total) * 7);
          onProgress?.(pct, "Downloading whisper model...");
        }
      },
    });

    if (!modelExisted) {
      onProgress?.(15, "Model downloaded");
    } else {
      onProgress?.(15, "Model ready");
    }
  }

  async extractAudio(
    inputPath: string,
    outputPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    onProgress?.(1, "Extracting audio...");

    // Verify input exists
    await access(inputPath);

    execSync(
      `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}" -y`,
      { stdio: "pipe" }
    );

    onProgress?.(5, "Audio extracted");
  }

  /**
   * Call whisper-cli directly (bypassing Remotion's transcribe wrapper)
   * to get clean sentence-level segments with correct Slovak characters.
   * Remotion's wrapper produces 1 BPE token per segment and corrupts
   * multi-byte chars (ľ, Ľ, ď, ň, ť) to U+FFFD.
   */
  private async runWhisperCli(
    audioPath: string,
    outputBase: string,
    onProgress?: ProgressCallback
  ): Promise<WhisperJsonOutput> {
    const cliBin = path.join(this.whisperPath, "build", "bin", "whisper-cli");
    const modelFile = path.join(
      this.whisperPath,
      `ggml-${MODEL}.bin`
    );

    return new Promise<WhisperJsonOutput>((resolve, reject) => {
      const args = [
        "-m", modelFile,
        "-f", audioPath,
        "-l", "sk",
        "--no-prints",
        "-ojf",                  // --output-json-full (includes per-token timestamps)
        "-of", outputBase,       // output file base (produces outputBase.json)
      ];

      const proc = spawn(cliBin, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        // Parse progress from whisper-cli stderr if available
        const match = /progress\s*=\s*(\d+)%/i.exec(stderr.slice(-200));
        if (match) {
          const pct = 16 + Math.round(parseInt(match[1]) * 0.79);
          onProgress?.(pct, "Transcribing audio...");
        }
      });

      proc.on("close", async (code) => {
        if (code !== 0) {
          return reject(new Error(`whisper-cli exited with code ${code}: ${stderr.slice(-500)}`));
        }

        try {
          const jsonPath = `${outputBase}.json`;
          const raw = await readFile(jsonPath, "utf-8");
          const parsed: WhisperJsonOutput = JSON.parse(raw);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse whisper JSON: ${err}`));
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Extract words from a segment using:
   *   - segment.text for the actual word strings (correct UTF-8 / Slovak chars)
   *   - token offsets for per-word timing (BPE text may be garbled but
   *     space-prefix boundaries and ms offsets are reliable)
   *   - segment.offsets.to as anchor for the last word's endMs, so that
   *     inter-segment silence is naturally preserved.
   */
  private segmentToWords(segment: WhisperJsonSegment): TranscriptWord[] {
    const segText = segment.text?.trim();
    if (!segText) return [];

    const wordStrings = segText.split(/\s+/);
    const segStart = segment.offsets.from;
    const segEnd = segment.offsets.to;

    // Build per-word timing from token offsets.
    // Space-prefixed tokens mark word boundaries in Whisper BPE.
    const textTokens = (segment.tokens ?? []).filter(
      (t) => t.text && !t.text.startsWith("[")
    );

    const timings: { from: number; to: number }[] = [];
    if (textTokens.length > 0) {
      let groupFrom = textTokens[0].offsets.from;
      let groupTo = textTokens[0].offsets.to;

      for (let i = 1; i < textTokens.length; i++) {
        const token = textTokens[i];
        if (token.text.startsWith(" ")) {
          // New word boundary — flush previous timing group
          timings.push({ from: groupFrom, to: groupTo });
          groupFrom = token.offsets.from;
        }
        groupTo = token.offsets.to;
      }
      // Last group anchored to segment end
      timings.push({ from: groupFrom, to: segEnd });
    }

    return wordStrings.map((word, i) => {
      if (i < timings.length) {
        return {
          word,
          startMs: timings[i].from,
          endMs: i === wordStrings.length - 1 ? segEnd : timings[i].to,
        };
      }
      // Fallback: distribute evenly within segment (should rarely happen)
      const step = (segEnd - segStart) / wordStrings.length;
      return {
        word,
        startMs: segStart + Math.round(i * step),
        endMs: i === wordStrings.length - 1 ? segEnd : segStart + Math.round((i + 1) * step),
      };
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

    // Step 2: Ensure binary + model
    await this.ensureInstalled(onProgress);

    // Step 3: Transcribe via whisper-cli directly (--output-json-full).
    // Natural sentence segments provide accurate boundaries; token-level
    // data within each segment gives word timing.
    onProgress?.(16, "Starting transcription...");

    const outputBase = path.join(sessionDir, "whisper-raw");
    const whisperOutput = await this.runWhisperCli(audioWav, outputBase, onProgress);

    onProgress?.(96, "Processing results...");

    // Build word-level data from segment tokens.
    // Segment boundaries are reliable anchors — silence between segments
    // is naturally captured without any heuristic gap injection.
    const words: TranscriptWord[] = [];

    for (const segment of whisperOutput.transcription) {
      words.push(...this.segmentToWords(segment));
    }

    // Compensate for Whisper's early-firing timestamps
    for (const w of words) {
      w.startMs += TIMING_OFFSET_MS;
      w.endMs += TIMING_OFFSET_MS;
    }

    const captions: CaptionWord[] = words.map((w, i) => ({
      text: i === 0 ? w.word : ` ${w.word}`,
      startMs: w.startMs,
      endMs: w.endMs,
      timestampMs: w.startMs,
      confidence: null,
    }));

    const transcript: TranscriptData = {
      words,
    };

    // Save processed outputs for debugging
    await writeFile(
      path.join(sessionDir, "transcript.json"),
      JSON.stringify(transcript, null, 2)
    );
    await writeFile(
      path.join(sessionDir, "captions.json"),
      JSON.stringify(captions, null, 2)
    );

    onProgress?.(100, "Transcription complete");

    return { transcript, captions };
  }
}

export const whisperService = new WhisperService();
export { WhisperService };
