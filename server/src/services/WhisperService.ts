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

export interface TranscriptionResult {
  transcript: TranscriptData;
  captions: CaptionWord[];
}

type ProgressCallback = (percent: number, message: string) => void;

/** Shape of one segment in whisper-cli's --output-json */
interface WhisperJsonSegment {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
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
        "-oj",                   // --output-json
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

    // Step 3: Transcribe via whisper-cli directly
    // This gives clean sentence-level segments with correct Slovak characters.
    onProgress?.(16, "Starting transcription...");

    const outputBase = path.join(sessionDir, "whisper-raw");
    const whisperOutput = await this.runWhisperCli(audioWav, outputBase, onProgress);

    onProgress?.(96, "Processing results...");

    // Build word-level data from sentence-level segments.
    // Each segment is a phrase/sentence with a time range — we split by
    // whitespace and distribute the segment duration proportionally.
    const words: TranscriptWord[] = [];
    const captions: CaptionWord[] = [];

    for (const segment of whisperOutput.transcription) {
      const segText = segment.text.trim();
      if (!segText) continue;

      const segWords = segText.split(/\s+/);
      const segStartMs = segment.offsets.from;
      const segEndMs = segment.offsets.to;
      const segDuration = segEndMs - segStartMs;

      // Distribute time proportionally by character count
      const totalChars = segWords.reduce((sum, w) => sum + w.length, 0);
      let cursor = segStartMs;

      for (const wordText of segWords) {
        const wordDuration =
          totalChars > 0
            ? Math.round((wordText.length / totalChars) * segDuration)
            : Math.round(segDuration / segWords.length);
        const wordStart = cursor;
        const wordEnd = Math.min(cursor + wordDuration, segEndMs);
        cursor = wordEnd;

        words.push({
          word: wordText,
          startMs: wordStart,
          endMs: wordEnd,
        });

        captions.push({
          text: captions.length === 0 ? wordText : ` ${wordText}`,
          startMs: wordStart,
          endMs: wordEnd,
          timestampMs: wordStart,
          confidence: null,
        });
      }
    }

    const transcript: TranscriptData = {
      words,
      text: words.map((w) => w.word).join(" "),
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
