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
const MAX_RETRIES = 3;    // retries per chunk on transient API error
const ROW_MISMATCH_RETRY_THRESHOLD = 0.90; // only retry if output is below 90% of expected rows
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
  }
  return false;
}

function isRowMismatchError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("row mismatch");
}

/**
 * Normalize a word for fuzzy comparison: strip diacritics, lowercase,
 * remove non-alphanumeric characters.
 */
function normalizeWord(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

/**
 * Levenshtein edit distance between two strings.
 */
function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Check if two normalized words are similar enough to be a correction
 * (not a completely different word from a dropped row).
 */
function isSimilar(normA: string, normB: string): boolean {
  if (normA === normB) return true;
  if (normA.length === 0 || normB.length === 0) return false;
  // Short words (≤3 chars): require exact match after normalization.
  // Slovak has many 1-2 char words (a, i, v, k, s, o, z, u, je, na, sa, to, do...)
  // that are completely different words despite low edit distance.
  if (normA.length <= 3 || normB.length <= 3) return false;
  const maxLen = Math.max(normA.length, normB.length);
  // Allow up to ~40% edit distance (generous for Slovak diacritics/spelling)
  const threshold = Math.ceil(maxLen * 0.4);
  return editDistance(normA, normB) <= threshold;
}

/**
 * When Gemini returns the correct row count, replace its (possibly mangled)
 * timestamps with the original input timestamps. Takes words positionally.
 */
function restoreTimestamps(inputLines: string[], outputLines: string[]): string[] {
  const inputs = inputLines.filter((l) => l.trim());
  const result: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const ts = inputs[i].split("\t")[0].trim();
    const outputWord = i < outputLines.length
      ? (() => { const tab = outputLines[i].indexOf("\t"); return tab >= 0 ? outputLines[i].substring(tab + 1) : outputLines[i]; })()
      : inputs[i].split("\t").slice(1).join("\t");
    result.push(`${ts}\t${outputWord}`);
  }
  return result;
}

/**
 * Repair a Gemini response that has the wrong number of rows.
 * Ignores Gemini's timestamps entirely (they may be mangled) and aligns
 * output words to input words using normalized text matching.
 * Uses greedy lookahead to handle dropped/extra rows without drifting.
 */
function repairChunkOutput(inputLines: string[], outputLines: string[]): string[] {
  const WINDOW = 5;

  // Parse input: keep original timestamps, extract words
  const inputs = inputLines.filter((l) => l.trim()).map((l) => {
    const [ts, ...rest] = l.split("\t");
    return { ts: ts.trim(), word: rest.join("\t"), norm: normalizeWord(rest.join("\t")) };
  });

  // Parse output: ignore timestamps, extract corrected words only
  const outputs = outputLines.map((l) => {
    const tab = l.indexOf("\t");
    const word = tab >= 0 ? l.substring(tab + 1) : l;
    return { word, norm: normalizeWord(word) };
  });

  const repaired: string[] = [];
  let outIdx = 0;
  let matched = 0;

  for (let inIdx = 0; inIdx < inputs.length; inIdx++) {
    const inp = inputs[inIdx];

    if (outIdx >= outputs.length) {
      // No more output rows — keep original
      repaired.push(`${inp.ts}\t${inp.word}`);
      continue;
    }

    // Fast path: normalized words match at current position
    if (outputs[outIdx].norm === inp.norm) {
      repaired.push(`${inp.ts}\t${outputs[outIdx].word}`);
      outIdx++;
      matched++;
      continue;
    }

    // Look ahead in output for this input word (output has extra rows)
    let outLook = -1;
    for (let j = 1; j < WINDOW && outIdx + j < outputs.length; j++) {
      if (outputs[outIdx + j].norm === inp.norm) { outLook = j; break; }
    }

    // Look ahead in input for this output word (input row was dropped)
    let inLook = -1;
    for (let j = 1; j < WINDOW && inIdx + j < inputs.length; j++) {
      if (inputs[inIdx + j].norm === outputs[outIdx].norm) { inLook = j; break; }
    }

    if (inLook >= 0 && (outLook < 0 || inLook <= outLook)) {
      // Current output word matches a later input word → this input row was dropped
      repaired.push(`${inp.ts}\t${inp.word}`);
      // Don't advance outIdx
    } else if (outLook >= 0) {
      // Current input word matches a later output word → skip extra output rows
      repaired.push(`${inp.ts}\t${outputs[outIdx + outLook].word}`);
      outIdx += outLook + 1;
      matched++;
    } else if (isSimilar(inp.norm, outputs[outIdx].norm)) {
      // Words are similar enough — this is a genuine correction
      repaired.push(`${inp.ts}\t${outputs[outIdx].word}`);
      outIdx++;
      matched++;
    } else {
      // Words are completely different — this input row was likely dropped
      // and the output word belongs to a later input row
      repaired.push(`${inp.ts}\t${inp.word}`);
      // Don't advance outIdx
    }
  }

  const total = inputs.length;
  console.log(`[GeminiService] Auto-repair: aligned ${matched}/${total} rows by word matching, kept ${total - matched} original`);

  return repaired;
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

      const expectedLines = chunkLines.filter((l) => l.trim()).length;

      const userMessage = [
        prompt,
        "",
        "## Reference Script (.md):",
        "",
        scriptText,
        "",
        `## Raw Transcription (.tsv) — exactly ${expectedLines} rows:`,
        "",
        chunkTsv,
        "",
        `REMINDER: Your output MUST contain exactly ${expectedLines} rows. Do not merge, split, or drop any rows. Preserve all timestamps exactly as written (HH:MM:SS.mmm format).`,
      ].join("\n");

      let resultLines: string[] = [];
      let retryFeedback: string | null = null; // mismatch feedback injected on retry
      let rowMismatchAttempts = 0;
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
            const ratio = resultLines.length / expectedLines;
            const detail = `Chunk ${i + 1}/${chunks.length} row mismatch: expected ${expectedLines}, got ${resultLines.length}.`;

            rowMismatchAttempts++;

            // Auto-repair immediately for small mismatches (>=90% rows present).
            // Only retry if the output is severely truncated (<90%) and we haven't retried yet.
            const shouldRetry = ratio < ROW_MISMATCH_RETRY_THRESHOLD && rowMismatchAttempts <= 1;

            if (!shouldRetry) {
              console.warn(`[GeminiService] ${detail} Auto-repairing via word alignment.`);
              onProgress(
                Math.round((i / chunks.length) * 80),
                `Chunk ${i + 1}/${chunks.length}: row mismatch (${resultLines.length}/${expectedLines}), auto-repairing...`,
              );
              resultLines = repairChunkOutput(chunkLines, resultLines);
              await this.setCachedChunk(sessionId, chunkHash, resultLines);
              break;
            }

            console.error(`[GeminiService] ${detail} Retrying (output severely truncated).`);

            retryFeedback = [
              `## CORRECTION REQUIRED (your previous output had ${resultLines.length} rows instead of ${expectedLines}):`,
              "You MUST output EXACTLY one row per input row. Do NOT merge or drop any rows.",
              "IMPORTANT: Preserve timestamps EXACTLY as given (HH:MM:SS.mmm format). Do NOT reformat them.",
            ].join("\n\n");

            throw new Error(detail);
          }

          // Validation passed — restore original timestamps (Gemini may reformat them)
          // and cache to disk
          resultLines = restoreTimestamps(chunkLines, resultLines);
          await this.setCachedChunk(sessionId, chunkHash, resultLines);
          break;
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));

          if (attempt < MAX_RETRIES && (isRetryableError(errObj) || isRowMismatchError(errObj))) {
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

  /**
   * Translate subtitle blocks to English.
   * Returns an array of translated text strings (same order & count as input).
   */
  async translateCaptions(
    blocks: { text: string; startMs: number; endMs: number }[],
    sourceLang: string,
    sessionId: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (blocks.length === 0) return [];

    const ai = await this.getClient();
    const langName = sourceLang === "sk" ? "Slovak" : sourceLang === "cs" ? "Czech" : "English";

    // Format as numbered lines for easy parsing
    const numberedLines = blocks.map((b, i) => `${i + 1}. ${b.text}`);
    const TRANSLATION_CHUNK = 200;
    const chunks: { start: number; end: number }[] = [];
    for (let i = 0; i < numberedLines.length; i += TRANSLATION_CHUNK) {
      chunks.push({ start: i, end: Math.min(i + TRANSLATION_CHUNK, numberedLines.length) });
    }

    const translated: string[] = new Array(blocks.length).fill("");

    for (let ci = 0; ci < chunks.length; ci++) {
      if (signal?.aborted) throw new Error("Cancelled");

      const chunk = chunks[ci];
      const chunkLabel = chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : "";
      onProgress(
        90 + Math.round((ci / chunks.length) * 8),
        `Translating captions to English${chunkLabel}...`,
      );

      const chunkLines = numberedLines.slice(chunk.start, chunk.end);
      const chunkHash = createHash("md5").update("translate_en:" + chunkLines.join("\n")).digest("hex");

      // Check cache
      const cached = await this.getCachedChunk(sessionId, chunkHash);
      if (cached) {
        for (let i = 0; i < cached.length && chunk.start + i < blocks.length; i++) {
          translated[chunk.start + i] = cached[i];
        }
        continue;
      }

      const expectedCount = chunkLines.length;
      const userMessage = [
        `Translate the following ${expectedCount} numbered subtitle lines from ${langName} to English.`,
        `Return EXACTLY ${expectedCount} numbered lines in the same format: "N. translated text".`,
        "Keep the translation natural and concise (subtitles should be short).",
        "Do NOT add, merge, split, or drop any lines. Every input line must have exactly one output line.",
        "",
        chunkLines.join("\n"),
        "",
        `REMINDER: You MUST return exactly ${expectedCount} numbered lines.`,
      ].join("\n");

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw new Error("Cancelled");

        try {
          const response = await ai.models.generateContent({
            model: MODEL,
            contents: userMessage,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            },
          });

          const text = response.text ?? "";
          // Parse numbered lines: "1. text" → "text"
          const resultLines = text.trim().split("\n")
            .map(l => l.replace(/^\d+\.\s*/, "").trim())
            .filter(l => l.length > 0);

          if (resultLines.length !== expectedCount) {
            throw new Error(
              `Translation row mismatch: expected ${expectedCount}, got ${resultLines.length}`,
            );
          }

          // Cache and store
          await this.setCachedChunk(sessionId, chunkHash, resultLines);
          for (let i = 0; i < resultLines.length; i++) {
            translated[chunk.start + i] = resultLines[i];
          }
          break;
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_RETRIES && (isRetryableError(errObj) || isRowMismatchError(errObj))) {
            const delay = RETRY_DELAY_MS * (attempt + 1);
            console.warn(`[GeminiService] Translation chunk ${ci} attempt ${attempt + 1} failed: ${errObj.message}. Retrying in ${delay / 1000}s...`);
            await sleep(delay);
            continue;
          }
          throw errObj;
        }
      }
    }

    return translated;
  }
}

export const geminiService = new GeminiService();
