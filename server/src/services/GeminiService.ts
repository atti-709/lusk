import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { settingsService } from "./SettingsService.js";

const MODEL = "gemini-2.5-pro";
const CHUNK_SIZE = 2000; // lines per chunk, matches existing download logic

type ProgressCallback = (percent: number, message: string) => void;

// ── Helpers ──

function msToTimestamp(ms: number): string {
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

function wordsToTsv(words: TranscriptWord[]): string {
  return words.map((w) => `${msToTimestamp(w.startMs)}\t${w.word}`).join("\n");
}

function extractCodeBlock(response: string): string {
  // Extract content from ```...``` code block
  const match = response.match(/```(?:tsv)?\s*\n([\s\S]*?)\n```/);
  if (match) return match[1].trim();
  // If no code block, assume the whole response is the TSV
  return response.trim();
}

// ── Service ──

class GeminiService {
  private correctionPromptCache: string | null = null;
  private viralClipPromptCache: string | null = null;

  private async getClient(): Promise<GoogleGenAI> {
    const apiKey = await settingsService.getGeminiApiKey();
    if (!apiKey) throw new Error("Gemini API key not configured");
    return new GoogleGenAI({ apiKey });
  }

  private async getCorrectionPrompt(): Promise<string> {
    if (this.correctionPromptCache) return this.correctionPromptCache;
    const promptPath = join(process.cwd(), "..", "client", "public", "prompts", "correction.md");
    this.correctionPromptCache = await readFile(promptPath, "utf-8");
    return this.correctionPromptCache;
  }

  private async getViralClipPrompt(): Promise<string> {
    if (this.viralClipPromptCache) return this.viralClipPromptCache;
    const promptPath = join(process.cwd(), "..", "client", "public", "prompts", "viral-clips.md");
    this.viralClipPromptCache = await readFile(promptPath, "utf-8");
    return this.viralClipPromptCache;
  }

  async isAvailable(): Promise<boolean> {
    const key = await settingsService.getGeminiApiKey();
    return !!key;
  }

  /**
   * Correct transcript using script as reference.
   * Returns the corrected TSV as a string.
   */
  async correctTranscript(
    words: TranscriptWord[],
    scriptText: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    const ai = await this.getClient();
    const prompt = await this.getCorrectionPrompt();
    const fullTsv = wordsToTsv(words);
    const lines = fullTsv.split("\n");

    // Chunk if needed
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      chunks.push(lines.slice(i, i + CHUNK_SIZE).join("\n"));
    }

    const correctedParts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error("Cancelled");

      const chunkLabel = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : "";
      onProgress(
        Math.round((i / chunks.length) * 80),
        `Correcting transcript with Gemini${chunkLabel}...`,
      );

      const userMessage = [
        prompt,
        "",
        "## Reference Script (.md):",
        "",
        scriptText,
        "",
        "## Raw Transcription (.tsv):",
        "",
        chunks[i],
      ].join("\n");

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
      });

      const text = response.text ?? "";
      correctedParts.push(extractCodeBlock(text));
    }

    return correctedParts.join("\n");
  }

  /**
   * Detect viral clips from corrected transcript.
   * Returns the raw clip text (CLIP 1\nTitle: ...) for parsing.
   */
  async detectViralClips(
    correctedTsv: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error("Cancelled");

    onProgress(85, "Finding viral clips with Gemini...");

    const ai = await this.getClient();
    const prompt = await this.getViralClipPrompt();

    const userMessage = [
      prompt,
      "",
      "## Corrected Transcript (.tsv):",
      "",
      correctedTsv,
    ].join("\n");

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userMessage,
    });

    return response.text ?? "";
  }
}

export const geminiService = new GeminiService();
