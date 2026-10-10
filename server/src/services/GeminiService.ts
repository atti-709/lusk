import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { setGlobalDispatcher, Agent } from "undici";
import { settingsService } from "./SettingsService.js";
import { tempManager } from "./TempManager.js";
import { alignCorrectedRows, keepHeardScript, misplacedBreaks } from "./alignCorrection.js";
import {
  applyProofreadEdits,
  buildProofreadLines,
  type ProofreadEdit,
  type ProofreadLine,
  type ProofreadResult,
} from "./proofread.js";

// Increase global fetch timeouts to 15 minutes to prevent Headers Timeout Error
// because undici defaults to 5 minutes (300_000ms) which breaks long Gemini streams.
setGlobalDispatcher(
  new Agent({
    headersTimeout: 15 * 60 * 1000,
    bodyTimeout: 15 * 60 * 1000,
    connectTimeout: 15 * 60 * 1000,
  })
);

/**
 * Row-for-row correction and translation. Measured on a full scripted episode (E64):
 * 3.5 Flash-Lite corrected more words than 3.1 and kept rows aligned best — the full
 * 3.8 Flash rewrites more freely, merging and dropping rows so word timings drift.
 */
const MODEL = "gemini-3.5-flash-lite";
/**
 * Clip selection and proofreading are judgement calls over the whole transcript rather
 * than a mechanical row-for-row rewrite, so they get the full Flash model with thinking.
 * Pinned — the `gemini-flash-latest` alias doesn't say which release it serves.
 */
const REASONING_MODEL = "gemini-3.8-flash";
const CHUNK_SIZE = 250;   // lines per API call
const OVERLAP = 30;       // lines of overlap from previous chunk
const MAX_RETRIES = 3;    // retries per chunk on transient API error
const ROW_MISMATCH_RETRY_THRESHOLD = 0.90; // only retry if output is below 90% of expected rows
const RETRY_DELAY_MS = 5000; // wait between retries

type ProgressCallback = (percent: number, message: string) => void;

const LANGUAGE_NAMES: Record<string, string> = { sk: "Slovak", cs: "Czech", en: "English" };

/** Sentences per proofread request — small enough that every line gets real attention. */
const PROOFREAD_CHUNK_LINES = 120;

/** One suggested clip, as Gemini returns it (timestamps not yet resolved). */
export interface GeminiClip {
  title: string;
  hook: string;
  takeaway: string;
  start: string;
  end: string;
  hook_score: number;
  flow_score: number;
  value_score: number;
  reach_score: number;
  score_reason: string;
}

const CLIP_SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short catchy title, in the transcript's language" },
          hook: { type: "string", description: "The opening hook sentence, verbatim" },
          takeaway: { type: "string", description: "The key insight the viewer gets, one sentence" },
          start: { type: "string", description: "HH:MM:SS.mmm of the clip's first word, copied from the TSV" },
          end: { type: "string", description: "HH:MM:SS.mmm of the word right after the clip's last sentence, copied from the TSV" },
          hook_score: { type: "integer", minimum: 1, maximum: 100 },
          flow_score: { type: "integer", minimum: 1, maximum: 100 },
          value_score: { type: "integer", minimum: 1, maximum: 100 },
          reach_score: { type: "integer", minimum: 1, maximum: 100 },
          score_reason: { type: "string", description: "One sentence: the clip's strongest and weakest aspect" },
        },
        required: ["title", "hook", "takeaway", "start", "end", "hook_score", "flow_score", "value_score", "reach_score", "score_reason"],
        propertyOrdering: ["title", "hook", "takeaway", "start", "end", "hook_score", "flow_score", "value_score", "reach_score", "score_reason"],
      },
    },
  },
  required: ["clips"],
};

const PROOFREAD_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "integer", description: "The line number the words are on" },
          find: { type: "string", description: "The wrong word(s), copied exactly as written on that line, contiguous" },
          replace: { type: "string", description: "The corrected word(s); empty string to delete" },
          reason: { type: "string", description: "A few words: what kind of error this is" },
        },
        required: ["line", "find", "replace", "reason"],
        propertyOrdering: ["line", "find", "replace", "reason"],
      },
    },
  },
  required: ["edits"],
};

/**
 * Drop images embedded in a reference script. A Google Docs Markdown export inlines every
 * picture as a base64 data URI (`[image1]: <data:image/png;base64,...>` plus `![][image1]`
 * where it sits) — E60's script was 774 KB of which 6 KB was text, and the script goes
 * out with every correction chunk.
 */
export function stripEmbeddedImages(script: string): string {
  return script
    .replace(/^\[[^\]]*\]:\s*<?data:[^\s>]*>?[ \t]*$/gm, "") // reference definitions
    .replace(/!\[[^\]]*\]\((?:<)?data:[^)]*\)/g, "")           // inline ![](data:...)
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")                      // ![][image1] references
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** No more than one clip per ~35 s of transcript, capped at the prompt's 16. */
function maxClipsFor(lastTimestamp: string): number {
  const [h, m, sec] = lastTimestamp.split(":").map(Number);
  const totalSec = (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
  return Math.max(3, Math.min(16, Math.floor(totalSec / 35)));
}

export function parseClipResponse(text: string): GeminiClip[] {
  const parsed = JSON.parse(text) as { clips?: GeminiClip[] };
  return Array.isArray(parsed.clips) ? parsed.clips : [];
}

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

/** Caption blocks per translation request. */
const TRANSLATION_CHUNK = 200;
const SENTENCE_END = /[.?!…]["'“”»]?$/;

/**
 * Split caption blocks into translation requests of at most `size`, each ending with a
 * sentence when one ends in its second half. A request cut mid-sentence came back short:
 * Gemini finished the sentence by merging its last lines, on every retry (E09).
 */
export function translationChunks(texts: string[], size: number): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  for (let start = 0; start < texts.length; ) {
    let end = Math.min(start + size, texts.length);
    if (end < texts.length) {
      for (let e = end; e > start + size / 2; e--) {
        if (SENTENCE_END.test(texts[e - 1].trim())) { end = e; break; }
      }
    }
    chunks.push({ start, end });
    start = end;
  }
  return chunks;
}

/** A translation range this short that still loses lines is translated line by line. */
const SMALL_TRANSLATION_RANGE = 8;

/** Sentence breaks before a lower-case word a correction chunk may add (a real fix, a quote). */
const MAX_ADDED_BREAKS = 2;

/**
 * Letters of a script Slovak and English subtitles never use. Gemini now and then writes a
 * Cyrillic look-alike into a Latin word ("svetло", E42).
 */
export function hasForeignScript(text: string): boolean {
  return /[\u0400-\u04FF\u0590-\u06FF\u3040-\u30FF\u4E00-\u9FFF]/.test(text);
}

/**
 * Gemini's numbered lines ("N. text", numbered from `first`) by their number; a line
 * without a number continues the one before. Lines it left out are empty strings.
 */
export function parseNumberedLines(text: string, first: number, count: number): string[] {
  const out: string[] = new Array(count).fill("");
  let at = -1;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\.\s*(.*)$/.exec(line);
    if (m) {
      at = Number(m[1]) - first;
      if (at >= 0 && at < count) out[at] = m[2].trim();
    } else if (at >= 0 && at < count) {
      out[at] = `${out[at]} ${line}`.trim();
    }
  }
  return out;
}

function isRowMismatchError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("row mismatch");
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

export class GeminiService {
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
    scriptText = stripEmbeddedImages(scriptText);
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
        // Caches written before content alignment hold rows mapped by index
        const aligned = alignCorrectedRows(chunkLines, cached);
        if (chunk.isFirst) {
          correctedLines.push(...aligned);
        } else {
          const overlapCount = chunks[i - 1].endIndex - chunk.startIndex;
          correctedLines.push(...aligned.slice(overlapCount));
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
              abortSignal: signal,
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
              console.warn(`[GeminiService] ${detail} Aligning rows by content.`);
              onProgress(
                Math.round((i / chunks.length) * 80),
                `Chunk ${i + 1}/${chunks.length}: row mismatch (${resultLines.length}/${expectedLines}), auto-repairing...`,
              );
              resultLines = alignCorrectedRows(chunkLines, resultLines);
            } else {
              console.error(`[GeminiService] ${detail} Retrying (output severely truncated).`);

              retryFeedback = [
                `## CORRECTION REQUIRED (your previous output had ${resultLines.length} rows instead of ${expectedLines}):`,
                "You MUST output EXACTLY one row per input row. Do NOT merge or drop any rows.",
                "IMPORTANT: Preserve timestamps EXACTLY as given (HH:MM:SS.mmm format). Do NOT reformat them.",
              ].join("\n\n");

              throw new Error(detail);
            }
          } else {
            // Right row count — still aligned by content, not index: a script word inserted
            // and another dropped would shift every row between them (see alignCorrection.ts)
            resultLines = alignCorrectedRows(chunkLines, resultLines);
          }

          resultLines = keepHeardScript(chunkLines, resultLines, hasForeignScript);
          // Full stops moved onto the word before ("malo byť. že každý…", E06): ask again,
          // and keep the heard rows if every answer does it
          const moved = misplacedBreaks(resultLines) - misplacedBreaks(chunkLines);
          if (moved > MAX_ADDED_BREAKS) {
            const detail = `Chunk ${i + 1}/${chunks.length} row mismatch: ${moved} sentence breaks before a lower-case word`;
            if (attempt < MAX_RETRIES) {
              retryFeedback = "## CORRECTION REQUIRED: your previous output put full stops before words that continue the sentence. Keep each punctuation mark on the word it follows in the transcription.";
              throw new Error(detail);
            }
            console.warn(`[GeminiService] ${detail}; keeping the uncorrected rows`);
            resultLines = chunkLines.filter((l) => l.trim());
          }
          await this.setCachedChunk(sessionId, chunkHash, resultLines);
          break;
        } catch (err: unknown) {
          if (signal?.aborted) throw new Error("Cancelled");
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
   * Detect viral clips from the (corrected) transcript.
   * Returns Gemini's clips as structured JSON (see CLIP_SCHEMA); timestamps are still
   * the raw strings Gemini copied out of the TSV and are snapped to words by the caller.
   */
  async detectViralClips(
    correctedTsv: string,
    lastTimestamp: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<GeminiClip[]> {
    if (signal?.aborted) throw new Error("Cancelled");

    onProgress(85, "Finding viral clips with Gemini...");

    const ai = await this.getClient();
    const prompt = await this.getViralClipPrompt();

    const userMessage = [
      prompt,
      "",
      `CONSTRAINT: The transcript ends at ${lastTimestamp}. All start and end timestamps MUST fall within 00:00:00.000 – ${lastTimestamp}. Do NOT suggest clips that extend beyond this range.`,
      `CONSTRAINT: Return at most ${maxClipsFor(lastTimestamp)} clips, none overlapping another.`,
      "",
      "## Corrected Transcript (.tsv):",
      "",
      correctedTsv,
    ].join("\n");

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: REASONING_MODEL,
          contents: userMessage,
          config: {
            abortSignal: signal,
            responseMimeType: "application/json",
            responseJsonSchema: CLIP_SCHEMA,
          },
        });
        return parseClipResponse(response.text ?? "");
      } catch (err: unknown) {
        if (signal?.aborted) throw new Error("Cancelled");
        const errObj = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES && isRetryableError(errObj)) {
          const delay = RETRY_DELAY_MS * (attempt + 1);
          console.warn(`[GeminiService] Clip detection attempt ${attempt + 1} failed (${errObj.message}). Retrying in ${delay / 1000}s...`);
          onProgress(85, `Gemini is busy — retrying in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        console.error("[GeminiService] Error during viral clip detection:", errObj.message);
        throw errObj;
      }
    }
  }

  /**
   * Proofread a timed transcript and return the word-level fixes as sparse edits.
   *
   * Rewriting the transcript row-for-row is what the correction pass does, and it is
   * where errors slip through: the model spends its effort keeping 250 rows and their
   * timestamps intact. Here it reads plain sentences and only reports what is wrong —
   * a short list of {find → replace} spans — so there is nothing to keep in sync, and
   * a span that does not match the transcript verbatim is simply dropped (see
   * `applyProofreadEdits`). That makes the pass safe to run on top of any transcript.
   */
  async proofreadTranscript(
    words: TranscriptWord[],
    scriptText: string | null,
    language: string,
    sessionId: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<ProofreadResult> {
    const ai = await this.getClient();
    if (scriptText) scriptText = stripEmbeddedImages(scriptText);
    const template = await settingsService.getProofreadPrompt();
    const prompt = template
      .replaceAll("{{LANGUAGE}}", LANGUAGE_NAMES[language] ?? language)
      .replace(
        "{{SCRIPT_NOTE}}",
        scriptText
          ? "## Reference script\n\nThe speaker worked from the reference script below (often written without diacritics). Use it to resolve names, terms, quotations and what a garbled word was meant to be. But the transcript records what was actually said: where the speaker deviated from the script, keep the spoken words."
          : "",
      );
    const lines = buildProofreadLines(words);
    const chunks: ProofreadLine[][] = [];
    for (let i = 0; i < lines.length; i += PROOFREAD_CHUNK_LINES) {
      chunks.push(lines.slice(i, i + PROOFREAD_CHUNK_LINES));
    }

    const edits: ProofreadEdit[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      if (signal?.aborted) throw new Error("Cancelled");
      const chunk = chunks[ci];
      const label = chunks.length > 1 ? ` (part ${ci + 1}/${chunks.length})` : "";
      onProgress(80 + Math.round((ci / chunks.length) * 5), `Proofreading transcript${label}...`);

      const body = chunk.map((l) => `${l.id}: ${l.words.map((i) => words[i].word).join(" ")}`).join("\n");
      const userMessage = [
        prompt,
        ...(scriptText ? ["", "## Reference Script:", "", scriptText] : []),
        "",
        "## Transcript:",
        "",
        body,
      ].join("\n");
      const hash = createHash("md5").update("proofread_v1:" + userMessage).digest("hex");

      let raw = await this.getCachedChunk(sessionId, hash).then((l) => l?.join("\n") ?? null);
      for (let attempt = 0; raw === null; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: REASONING_MODEL,
            contents: userMessage,
            config: {
              abortSignal: signal,
              responseMimeType: "application/json",
              responseJsonSchema: PROOFREAD_SCHEMA,
            },
          });
          raw = response.text ?? "";
          JSON.parse(raw); // only cache a well-formed answer
          await this.setCachedChunk(sessionId, hash, [raw]);
        } catch (err: unknown) {
          raw = null;
          if (signal?.aborted) throw new Error("Cancelled");
          const errObj = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_RETRIES && (isRetryableError(errObj) || errObj instanceof SyntaxError)) {
            const delay = RETRY_DELAY_MS * (attempt + 1);
            console.warn(`[GeminiService] Proofread chunk ${ci} attempt ${attempt + 1} failed (${errObj.message}). Retrying in ${delay / 1000}s...`);
            await sleep(delay);
            continue;
          }
          throw errObj;
        }
      }

      const parsed = JSON.parse(raw) as { edits?: ProofreadEdit[] };
      edits.push(...(parsed.edits ?? []));
    }

    return applyProofreadEdits(words, lines, edits);
  }

  /**
   * Translate subtitle blocks to English: exactly one English line per block, so every English
   * cue keeps its Slovak cue's time. Returns the lines in input order.
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
    const texts = blocks.map((b) => b.text);
    const chunks = translationChunks(texts, TRANSLATION_CHUNK);
    const translated: string[] = new Array(blocks.length).fill("");

    for (let ci = 0; ci < chunks.length; ci++) {
      if (signal?.aborted) throw new Error("Cancelled");
      const chunk = chunks[ci];
      const chunkLabel = chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : "";
      onProgress(90 + Math.round((ci / chunks.length) * 8), `Translating captions to English${chunkLabel}...`);
      const lines = await this.translateRange(ai, texts, chunk.start, chunk.end, langName, sessionId, signal);
      lines.forEach((line, i) => (translated[chunk.start + i] = line));
    }

    return translated;
  }

  /**
   * One English line for each of texts[start, end). A long range Gemini answers with lines
   * missing is translated again in halves: a missing line means it merged that line into a
   * neighbour, and the lines around it had often slid by one (E00: the English ran a line
   * ahead of the Slovak for a minute). A short range that still loses lines is translated
   * line by line.
   */
  private async translateRange(
    ai: GoogleGenAI,
    texts: string[],
    start: number,
    end: number,
    langName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const count = end - start;
    const numbered = texts.slice(start, end).map((t, i) => `${start + i + 1}. ${t}`);
    const hash = createHash("md5").update("translate_en:" + numbered.join("\n")).digest("hex");
    const cached = await this.getCachedChunk(sessionId, hash);
    if (cached && cached.length === count && cached.every(Boolean)) return cached;

    const userMessage = [
      `Translate the following ${count} numbered subtitle lines from ${langName} to English.`,
      `Return EXACTLY ${count} numbered lines in the same format: "N. translated text".`,
      "Keep the translation natural and concise (subtitles should be short).",
      "Do NOT add, merge, split, or drop any lines. Every input line must have exactly one output line.",
      "",
      numbered.join("\n"),
      "",
      `REMINDER: You MUST return exactly ${count} numbered lines.`,
    ].join("\n");

    const missingIn = (lines: string[]) => lines.filter((l) => !l).length;
    let best: string[] = new Array(count).fill("");
    // a long range gets two tries before it is split: its halves are likelier to come back whole
    const tries = count > SMALL_TRANSLATION_RANGE ? 2 : MAX_RETRIES + 1;
    for (let attempt = 0; attempt < tries && missingIn(best) > 0; attempt++) {
      if (signal?.aborted) throw new Error("Cancelled");
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: userMessage,
          config: { abortSignal: signal, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
        });
        // a line in a foreign script (a Cyrillic "л" in "svetло") counts as missing
        const lines = parseNumberedLines(response.text ?? "", start + 1, count).map((l) => (hasForeignScript(l) ? "" : l));
        if (missingIn(lines) < missingIn(best)) best = lines;
      } catch (err: unknown) {
        if (signal?.aborted) throw new Error("Cancelled");
        const errObj = err instanceof Error ? err : new Error(String(err));
        if (attempt + 1 < tries && isRetryableError(errObj)) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw errObj;
      }
    }

    if (missingIn(best) > 0 && count > SMALL_TRANSLATION_RANGE) {
      console.warn(`[GeminiService] Translation of lines ${start + 1}-${end}: ${missingIn(best)} missing, translating it in halves`);
      const mid = start + translationChunks(texts.slice(start, end), Math.ceil(count / 2))[0].end;
      best = [
        ...(await this.translateRange(ai, texts, start, mid, langName, sessionId, signal)),
        ...(await this.translateRange(ai, texts, mid, end, langName, sessionId, signal)),
      ];
    } else if (missingIn(best) > 0) {
      console.warn(`[GeminiService] Translation of lines ${start + 1}-${end}: ${missingIn(best)} missing, translating line by line`);
      best = [];
      for (let i = start; i < end; i++) best.push(await this.translateLine(ai, texts, i, langName, signal));
    }

    if (best.every(Boolean)) await this.setCachedChunk(sessionId, hash, best);
    return best;
  }

  /** One subtitle line on its own, its neighbours given as context only. */
  private async translateLine(
    ai: GoogleGenAI,
    texts: string[],
    index: number,
    langName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const userMessage = [
      `Translate ONE subtitle line from ${langName} to English. Return only the English translation of that line, nothing else.`,
      "",
      `Previous lines (context only): ${texts.slice(Math.max(0, index - 2), index).join(" / ") || "-"}`,
      `Line to translate: ${texts[index]}`,
      `Next lines (context only): ${texts.slice(index + 1, index + 3).join(" / ") || "-"}`,
    ].join("\n");
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error("Cancelled");
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: userMessage,
          config: { abortSignal: signal, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
        });
        const line = (response.text ?? "").trim().split("\n")[0].replace(/^\d+\.\s*/, "").trim();
        if (line && !hasForeignScript(line)) return line;
      } catch (err: unknown) {
        if (signal?.aborted) throw new Error("Cancelled");
        const errObj = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES && isRetryableError(errObj)) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw errObj;
      }
    }
    return "";
  }
}

export const geminiService = new GeminiService();
