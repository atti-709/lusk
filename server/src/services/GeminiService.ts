import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { setGlobalDispatcher, Agent } from "undici";
import { settingsService } from "./SettingsService.js";
import { tempManager } from "./TempManager.js";

// Increase global fetch timeouts to 15 minutes to prevent Headers Timeout Error
// because undici defaults to 5 minutes (300_000ms) which breaks long Gemini streams.
setGlobalDispatcher(
  new Agent({
    headersTimeout: 15 * 60 * 1000,
    bodyTimeout: 15 * 60 * 1000,
    connectTimeout: 15 * 60 * 1000,
  })
);

const MODEL = "gemini-3.1-flash-lite-preview";
const CHUNK_SIZE = 250;   // lines per API call
const OVERLAP = 30;       // lines of overlap from previous chunk
const MAX_RETRIES = 3;    // retries per chunk on validation failure or transient API error
const RETRY_DELAY_MS = 5000; // wait between retries

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

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    // Gemini 503 / 429 / rate limit
    if (msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE") || msg.includes("RESOURCE_EXHAUSTED")) return true;
    // Our own row count validation failure
    if (msg.includes("row mismatch")) return true;
  }
  return false;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export { wordsToTsv, msToTimestamp };

function extractCodeBlock(response: string): string {
  // Extract content from ```...``` code block
  const match = response.match(/```(?:tsv)?\s*\n([\s\S]*?)\n```/);
  if (match) return match[1].trim();
  // If no code block, assume the whole response is the TSV
  return response.trim();
}

// ── Service ──

class GeminiService {
  private chunkCacheDir(sessionId: string): string {
    return join(tempManager.getSessionDir(sessionId), "chunk_cache");
  }

  private async getCachedChunk(sessionId: string, hash: string): Promise<string[] | null> {
    try {
      const data = await readFile(join(this.chunkCacheDir(sessionId), `${hash}.tsv`), "utf-8");
      return data.split("\n").filter((l) => l.trim());
    } catch {
      return null;
    }
  }

  private async setCachedChunk(sessionId: string, hash: string, lines: string[]): Promise<void> {
    const dir = this.chunkCacheDir(sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hash}.tsv`), lines.join("\n"), "utf-8");
  }

  private async getClient(): Promise<GoogleGenAI> {
    const apiKey = await settingsService.getGeminiApiKey();
    if (!apiKey) throw new Error("Gemini API key not configured");
    return new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 600 * 1000 }, // 10 minute timeout for large transcript chunks
    });
  }

  private async getCorrectionPrompt(): Promise<string> {
    return settingsService.getCorrectionPrompt();
  }

  private async getViralClipPrompt(): Promise<string> {
    return settingsService.getViralClipsPrompt();
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
    sessionId: string,
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
      const chunkHash = createHash("md5").update(chunkTsv).digest("hex");

      // Check cache — skip API call if this exact chunk was already corrected
      const cached = await this.getCachedChunk(sessionId, chunkHash);
      if (cached) {
        console.log(`[GeminiService] Chunk ${i} cache hit, skipping API call`);
        if (chunk.isFirst) {
          correctedLines.push(...cached);
        } else {
          const overlapCount = chunks[i - 1].endIndex - chunk.startIndex;
          correctedLines.push(...cached.slice(overlapCount));
        }
        continue;
      }

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

      const expectedLines = chunkLines.filter((l) => l.trim()).length;

      let resultLines: string[] = [];
      let retryFeedback: string | null = null; // mismatch feedback injected on retry
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw new Error("Cancelled");

        try {
          // On retry after row mismatch, append correction feedback to the prompt
          const contents = retryFeedback
            ? userMessage + "\n\n" + retryFeedback
            : userMessage;

          const response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: {
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.MINIMAL,
              }
            }
          });

          const text = response.text ?? "";
          resultLines = extractCodeBlock(text).split("\n").filter((l) => l.trim());

          if (resultLines.length !== expectedLines) {
            const inputTimestamps = chunkLines.map((l) => l.split("\t")[0]);
            const outputTimestamps = resultLines.map((l) => l.split("\t")[0]);
            const missing = inputTimestamps.filter((ts) => !outputTimestamps.includes(ts));
            const extra = outputTimestamps.filter((ts) => !inputTimestamps.includes(ts));

            const detail = [
              `Chunk ${i + 1}/${chunks.length} row mismatch: expected ${expectedLines}, got ${resultLines.length}.`,
              missing.length ? `Missing timestamps: ${missing.join(", ")}` : null,
              extra.length ? `Extra timestamps: ${extra.join(", ")}` : null,
            ].filter(Boolean).join(" ");
            console.error(`[GeminiService] ${detail}`);

            // Build feedback for the next retry attempt
            const feedbackParts = [
              `## CORRECTION REQUIRED (your previous output had ${resultLines.length} rows instead of ${expectedLines}):`,
              "You MUST output EXACTLY one row per input row. Do NOT merge or drop any rows.",
            ];
            if (missing.length) {
              feedbackParts.push(`You DROPPED these timestamps — they MUST appear in your output:\n${missing.join("\n")}`);
            }
            if (extra.length) {
              feedbackParts.push(`You ADDED these invalid timestamps — remove them:\n${extra.join("\n")}`);
            }
            retryFeedback = feedbackParts.join("\n\n");

            throw new Error(detail);
          }

          // Validation passed — cache to disk and break out of retry loop
          await this.setCachedChunk(sessionId, chunkHash, resultLines);
          break;
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));

          if (attempt < MAX_RETRIES && isRetryableError(errObj)) {
            const delay = RETRY_DELAY_MS * (attempt + 1); // linear backoff
            console.warn(`[GeminiService] Chunk ${i} attempt ${attempt + 1} failed (${errObj.message}). Retrying in ${delay / 1000}s...`);
            onProgress(
              Math.round((i / chunks.length) * 80),
              `Chunk ${i + 1}/${chunks.length} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${errObj.message}. Retrying in ${delay / 1000}s...`,
            );
            await sleep(delay);
            continue;
          }

          // Non-retryable or exhausted retries
          console.error(`[GeminiService] Chunk ${i} failed after ${attempt + 1} attempt(s):`, errObj.message);
          throw errObj;
        }
      }

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
    lastTimestamp: string,
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
      `CONSTRAINT: The transcript ends at ${lastTimestamp}. All Start and End timestamps MUST fall within 00:00:00.000 – ${lastTimestamp}. Do NOT suggest clips that extend beyond this range.`,
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
