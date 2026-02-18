import path from "node:path";
import { execSync } from "node:child_process";
import { access } from "node:fs/promises";
import {
  installWhisperCpp,
  downloadWhisperModel,
  transcribe,
  toCaptions,
} from "@remotion/install-whisper-cpp";
import type { TranscriptData, TranscriptWord, CaptionWord } from "@lusk/shared";

const WHISPER_CPP_VERSION = "1.8.3";
const MODEL = "large-v3-turbo";

export interface TranscriptionResult {
  transcript: TranscriptData;
  captions: CaptionWord[];
}

type ProgressCallback = (percent: number, message: string) => void;

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

    // Step 3: Transcribe
    onProgress?.(16, "Starting transcription...");

    const whisperOutput = await transcribe({
      inputPath: audioWav,
      whisperPath: this.whisperPath,
      whisperCppVersion: WHISPER_CPP_VERSION,
      model: MODEL,
      tokenLevelTimestamps: true,
      language: "sk",
      printOutput: false,
      onProgress: (p) => {
        const pct = 16 + Math.round(p * 79);
        onProgress?.(pct, "Transcribing audio...");
      },
    });

    onProgress?.(96, "Processing results...");

    // Step 4: Convert to captions
    const { captions } = toCaptions({ whisperCppOutput: whisperOutput });

    // Step 5: Build TranscriptData from whisper output
    const words: TranscriptWord[] = [];
    for (const segment of whisperOutput.transcription) {
      for (const token of segment.tokens) {
        const text = token.text.trim();
        if (!text) continue;
        words.push({
          word: text,
          startMs: token.offsets.from,
          endMs: token.offsets.to,
        });
      }
    }

    const transcript: TranscriptData = {
      words,
      text: whisperOutput.transcription.map((s) => s.text).join(" ").trim(),
    };

    onProgress?.(100, "Transcription complete");

    return { transcript, captions };
  }
}

export const whisperService = new WhisperService();
export { WhisperService };
