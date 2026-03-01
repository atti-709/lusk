import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { setGlobalDispatcher, Agent } from "undici";
import { settingsService } from "./SettingsService.js";
import { getClientPublicDir } from "../config/paths.js";

// Increase global fetch timeouts to 15 minutes to prevent Headers Timeout Error
// because undici defaults to 5 minutes (300_000ms) which breaks long Gemini streams.
setGlobalDispatcher(
  new Agent({
    headersTimeout: 15 * 60 * 1000,
    bodyTimeout: 15 * 60 * 1000,
    connectTimeout: 15 * 60 * 1000,
  })
);

const MODEL = "gemini-3-flash-preview";
// const MODEL = "gemini-3.1-pro-preview";
const CHUNK_SIZE = 250;   // lines per API call
const OVERLAP = 30;       // lines of overlap from previous chunk

type ProgressCallback = (percent: number, message: string) => void;

export interface ChunkWindow {
  startIndex: number;  // inclusive
  endIndex: number;    // exclusive
  isFirst: boolean;
}

export function buildSlidingWindowChunks(
  lines: string[],
  chunkSize: number = CHUNK_SIZE,
  overlap: number = OVERLAP,
): ChunkWindow[] {
  if (overlap >= chunkSize) {
    throw new Error(`overlap (${overlap}) must be less than chunkSize (${chunkSize})`);
  }
  if (lines.length <= chunkSize) {
    return [{ startIndex: 0, endIndex: lines.length, isFirst: true }];
  }

  const stride = chunkSize - overlap;
  const chunks: ChunkWindow[] = [];

  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + chunkSize, lines.length);
    chunks.push({ startIndex: start, endIndex: end, isFirst: start === 0 });
    if (end === lines.length) break;
  }

  // Merge tiny tail: if the last chunk's NEW portion (beyond previous chunk's coverage)
  // is smaller than the overlap, absorb it into the previous chunk
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    const newLines = last.endIndex - prev.endIndex;
    if (newLines < overlap) {
      chunks.pop();
      chunks[chunks.length - 1] = {
        ...prev,
        endIndex: last.endIndex,
      };
    }
  }

  return chunks;
}

export function validateChunkRowCount(
  actual: number,
  expected: number,
  chunkIndex: number,
  totalChunks: number,
  startTimestamp: string,
  endTimestamp: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `Chunk validation failed: chunk ${chunkIndex + 1}/${totalChunks}, ` +
      `expected ${expected} lines, got ${actual}. ` +
      `Timestamp range: ${startTimestamp} – ${endTimestamp}. ` +
      `Pipeline halted. Investigate this segment manually.`,
    );
  }
}

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

export { wordsToTsv };

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
    return new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 600 * 1000 }, // 10 minute timeout for large transcript chunks
    });
  }

  private async getCorrectionPrompt(): Promise<string> {
    if (this.correctionPromptCache) return this.correctionPromptCache;
    const promptPath = join(getClientPublicDir(), "prompts", "correction-api.md");
    this.correctionPromptCache = await readFile(promptPath, "utf-8");
    return this.correctionPromptCache;
  }

  private async getViralClipPrompt(): Promise<string> {
    if (this.viralClipPromptCache) return this.viralClipPromptCache;
    const promptPath = join(getClientPublicDir(), "prompts", "viral-clips-api.md");
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

    const chunks = buildSlidingWindowChunks(lines);
    const correctedLines: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error("Cancelled");

      const chunk = chunks[i];
      const chunkLabel = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : "";
      onProgress(
        Math.round((i / chunks.length) * 80),
        `Correcting transcript with Gemini${chunkLabel}...`,
      );

      const chunkLines = lines.slice(chunk.startIndex, chunk.endIndex);
      const chunkTsv = chunkLines.join("\n");

      const userMessage = [
        prompt,
        "",
        "## Reference Script (.md):",
        "",
        scriptText,
        "",
        "## Raw Transcription (.tsv):",
        "",
        chunkTsv,
      ].join("\n");

      let response;
      try {
        response = await ai.models.generateContent({
          model: MODEL,
          contents: userMessage,
        });
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        console.error(`[GeminiService] Error during transcript correction chunk ${i}:`, errObj.message);
        console.error(`[GeminiService] Request payload sample:`, userMessage.substring(0, 500) + "...");
        throw errObj;
      }

      const text = response.text ?? "";
      const resultLines = extractCodeBlock(text).split("\n").filter((l) => l.trim());

      // Validate: LLM must return exactly as many lines as we sent
      const startTs = chunkLines[0]?.split("\t")[0] ?? "?";
      const endTs = chunkLines[chunkLines.length - 1]?.split("\t")[0] ?? "?";
      const expectedLines = chunkLines.filter((l) => l.trim()).length;
      validateChunkRowCount(resultLines.length, expectedLines, i, chunks.length, startTs, endTs);

      if (chunk.isFirst) {
        correctedLines.push(...resultLines);
      } else {
        const overlapCount = chunks[i - 1].endIndex - chunk.startIndex;
        correctedLines.push(...resultLines.slice(overlapCount));
      }
    }

    // Final validation: total output must match total input
    const expectedTotalLines = lines.filter((l) => l.trim()).length;
    if (correctedLines.length !== expectedTotalLines) {
      throw new Error(
        `Final validation failed: input had ${expectedTotalLines} lines, ` +
        `but corrected output has ${correctedLines.length} lines. ` +
        `Pipeline halted.`,
      );
    }

    return correctedLines.join("\n");
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

    let response;
    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      console.error("[GeminiService] Error during viral clip detection:", errObj.message);
      console.error("[GeminiService] Request payload sample:", userMessage.substring(0, 500) + "...");
      throw errObj;
    }

    return response.text ?? "";
  }
}

export const geminiService = new GeminiService();
