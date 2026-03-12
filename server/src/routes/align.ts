import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { settingsService, type TranscriptionLanguage } from "../services/SettingsService.js";
import archiver from "archiver";
import type { ErrorResponse, TranscriptWord, ViralClip, CaptionWord } from "@lusk/shared";
import { runGeminiAutomation } from "./transcribe.js";

// ── Helpers ──

function msToTimestamp(ms: number): string {
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function timestampToMs(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 3) {
    // HH:MM:SS.mmm
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const s = parseFloat(parts[2]);
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  }
  if (parts.length === 2) {
    // MM:SS.mmm (Gemini sometimes abbreviates 00:00:11.260 as 00:11.260)
    const m = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    return Math.round((m * 60 + s) * 1000);
  }
  throw new Error(`Invalid timestamp: ${ts}`);
}

function wordsToTsv(words: TranscriptWord[]): string {
  return words.map((w) => `${msToTimestamp(w.startMs)}\t${w.word}`).join("\n");
}

export function parseTsv(tsv: string, fallbackEndMs: number): TranscriptWord[] {
  const lines = tsv.trim().split("\n").filter((l) => l.trim());
  const words: TranscriptWord[] = [];
  for (const line of lines) {
    const [timestamp, ...rest] = line.split("\t");
    const word = rest.join("\t").trim();
    if (!timestamp || !word) continue;
    words.push({ word, startMs: timestampToMs(timestamp.trim()), endMs: 0 });
  }
  // Compute endMs: next word's startMs, last word uses fallbackEndMs
  for (let i = 0; i < words.length; i++) {
    words[i].endMs = i < words.length - 1 ? words[i + 1].startMs : fallbackEndMs;
  }
  return words;
}

export function parseViralClipText(text: string): ViralClip[] {
  const clips: ViralClip[] = [];
  // Split on "CLIP N" headers
  const blocks = text.split(/^CLIP\s+\d+/im).filter((b) => b.trim());

  for (const block of blocks) {
    const titleMatch = block.match(/Title:\s*(.+)/i);
    const hookMatch = block.match(/Hook:\s*(.+)/i);
    const startMatch = block.match(/Start:\s*(\S+)/i);
    const endMatch = block.match(/End:\s*(\S+)/i);

    if (startMatch && endMatch) {
      clips.push({
        title: titleMatch?.[1]?.trim() ?? "Untitled",
        hookText: hookMatch?.[1]?.trim() ?? "",
        startMs: timestampToMs(startMatch[1]),
        endMs: timestampToMs(endMatch[1]),
      });
    }
  }
  return clips;
}

export function wordsToCaptions(words: TranscriptWord[]): CaptionWord[] {
  return words.map((w, i) => ({
    text: i === 0 ? w.word : ` ${w.word}`,
    startMs: w.startMs,
    endMs: w.endMs,
    timestampMs: w.startMs,
    confidence: null,
  }));
}

// ── Routes ──

export async function alignRoute(app: FastifyInstance) {
  // 5a. Download transcript as TSV
  app.get<{ Params: { projectId: string }; Reply: string | ErrorResponse | unknown }>(
    "/api/projects/:projectId/transcript.tsv",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.transcript) {
        return reply.status(400).send({ success: false, error: "No transcript available" });
      }

      const tsv = wordsToTsv(session.transcript.words);
      const lines = tsv.split("\n");

      // If short enough, download as single file
      if (lines.length <= 2000) {
        return reply
          .header("Content-Type", "text/tab-separated-values")
          .header("Content-Disposition", 'attachment; filename="transcription.tsv"')
          .send(tsv);
      }

      // Otherwise, create a zip with chunks
      const archive = archiver("zip", {
        zlib: { level: 9 }, // Sets the compression level.
      });

      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", 'attachment; filename="transcription_chunked.zip"');

      // Pipe archive data to the response
      // Fastify handles streams if we return the stream in send()
      // However, archiver needs to be finalized.
      
      archive.on("error", (err: unknown) => {
        throw err;
      });

      // 1. Add full transcript
      archive.append(tsv, { name: "transcription_full.tsv" });

      // 2. Add chunks
      const CHUNK_SIZE = 2000;
      let part = 1;
      for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        const chunk = lines.slice(i, i + CHUNK_SIZE).join("\n");
        archive.append(chunk, { name: `transcription_part_${part}.tsv` });
        part++;
      }

      // Finalize the archive (this indicates we are done appending)
      archive.finalize();

      return reply.send(archive);
    }
  );

  // 5b. Upload corrected transcript
  app.post<{
    Params: { projectId: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/corrected-transcript",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.transcript) {
        return reply.status(400).send({ success: false, error: "No transcript to correct" });
      }

      // Accept raw text body (TSV content)
      const rawBody = typeof request.body === "string"
        ? request.body
        : (request.body as { text?: string })?.text;

      // If text is empty/just whitespace or not provided, assume the user deleted the text
      // to revert back to the original transcript.
      if (!rawBody || !rawBody.trim()) {
        try {
          if (session.originalTranscript) {
             orchestrator.setTranscript(projectId, session.originalTranscript);
             orchestrator.setCaptions(projectId, wordsToCaptions(session.originalTranscript.words));
          }
          orchestrator.setCorrectedTranscriptRaw(projectId, "");
          return { success: true as const };
        } catch (err) {
           return reply.status(400).send({
              success: false,
              error: `Failed to restore original transcript: ${err instanceof Error ? err.message : String(err)}`,
           });
        }
      }

      try {
        const lastWord = session.transcript.words.at(-1);
        const fallbackEndMs = lastWord ? lastWord.endMs : 0;
        const correctedWords = parseTsv(rawBody, fallbackEndMs);

        const correctedTranscript = {
          text: "", // TODO: Reconstruct if needed, but for alignment words are key
          words: correctedWords,
        };

        orchestrator.setTranscript(projectId, correctedTranscript);
        orchestrator.setCorrectedTranscriptRaw(projectId, rawBody);
        orchestrator.setCaptions(projectId, wordsToCaptions(correctedWords));

        return { success: true as const };
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: `Failed to parse TSV: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  );

  // 5c. Submit viral clips (parsed from Gemini text output)
  app.post<{
    Params: { projectId: string };
    Body: { text: string };
    Reply: { success: true; clips: ViralClip[] } | ErrorResponse;
  }>(
    "/api/projects/:projectId/viral-clips",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const { text } = (request.body ?? {}) as Partial<{ text: string }>;

      try {
        // Empty text means "skip viral clip detection" — proceed to READY with 0 clips
        const clips = text?.trim() ? parseViralClipText(text) : [];

        orchestrator.setViralClips(projectId, clips);

        // Regenerate captions from (possibly corrected) transcript
        if (session.transcript) {
          orchestrator.setCaptions(projectId, wordsToCaptions(session.transcript.words));
        }

        orchestrator.transition(projectId, "READY");
        orchestrator.updateProgress(projectId, 100, "Ready to review");

        return { success: true as const, clips };
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: `Failed to parse clips: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  );

  // 5d. Add a single clip manually
  app.post<{
    Params: { projectId: string };
    Body: ViralClip;
    Reply: { success: true; clips: ViralClip[] } | ErrorResponse;
  }>(
    "/api/projects/:projectId/clips",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const clip = request.body as ViralClip;
      if (clip.startMs == null || clip.endMs == null || clip.endMs <= clip.startMs) {
        return reply.status(400).send({ success: false, error: "Invalid start/end times" });
      }

      const existing = session.viralClips ?? [];
      const updated = [...existing, clip];
      orchestrator.setViralClips(projectId, updated);

      return { success: true as const, clips: updated };
    }
  );

  // 5e. Go back to align step from READY
  app.post<{
    Params: { projectId: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/back-to-align",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      try {
        orchestrator.transition(projectId, "ALIGNING");
        orchestrator.updateProgress(projectId, 100, "Modify transcript or clips");
        return { success: true as const };
      } catch (err) {
        return reply.status(409).send({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
// Helper to format SRT timestamp: HH:MM:SS,mmm
function msToSrtTimestamp(ms: number): string {
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const msStr = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${msStr}`;
}

// Per-language word sets for subtitle line-breaking
const NO_BREAK_BEFORE: Record<TranscriptionLanguage, Set<string>> = {
  sk: new Set(["a", "i", "v", "k", "s", "z", "u", "o"]),
  cs: new Set(["a", "i", "v", "k", "s", "z", "u", "o"]),
  en: new Set(["a", "I"]),
};

const BREAK_BEFORE: Record<TranscriptionLanguage, Set<string>> = {
  sk: new Set([
    // Conjunctions
    "ale", "alebo", "že", "keď", "aby", "pretože", "lebo", "ak",
    "ani", "no", "však", "teda", "takže", "preto", "hoci", "kde", "keďže",
    // Relative / interrogative
    "ktorý", "ktorá", "ktoré", "ktorí", "ktorým", "ktorých", "čo", "kto",
    // Common prepositions
    "na", "do", "od", "pre", "pri", "po", "za", "bez", "cez", "nad", "pod", "medzi",
  ]),
  cs: new Set([
    // Conjunctions
    "ale", "nebo", "že", "když", "aby", "protože", "pokud", "jenže",
    "ani", "no", "však", "tedy", "takže", "proto", "ačkoli", "kde", "jelikož",
    // Relative / interrogative
    "který", "která", "které", "kteří", "kterým", "kterých", "co", "kdo",
    // Common prepositions
    "na", "do", "od", "pro", "při", "po", "za", "bez", "přes", "nad", "pod", "mezi",
  ]),
  en: new Set([
    // Conjunctions
    "but", "or", "and", "that", "when", "because", "since", "if",
    "although", "though", "while", "so", "yet", "nor",
    // Relative / interrogative
    "which", "who", "whom", "whose", "where", "what", "how",
    // Common prepositions
    "in", "on", "at", "to", "for", "with", "from", "by", "about",
    "into", "through", "during", "before", "after", "between", "under", "over",
  ]),
};

function isBreakPoint(word: string, lang: TranscriptionLanguage): boolean {
  const w = word.toLowerCase().replace(/[.,;:!?"""()–—]/g, "");
  return BREAK_BEFORE[lang].has(w);
}

function endsWithPunctuation(word: string): boolean {
  return /[.,;:!?"""()–—]$/.test(word.trim());
}

function blockTextLength(words: CaptionWord[]): number {
  return words.reduce((acc, w) => acc + w.text.trim().length + 1, 0) - 1;
}

// Apply the pyramid rule: split into 2 lines where top line ≤ bottom line,
// preferring phrase-boundary breaks.
function applyPyramidRule(words: CaptionWord[], maxLineChars: number, lang: TranscriptionLanguage): string {
  const full = words.map(w => w.text.trim()).join(" ");
  if (full.length <= maxLineChars) return full;

  const texts = words.map(w => w.text.trim());
  const totalLen = full.length;
  const idealTop = Math.floor(totalLen / 2); // aim for top ≤ bottom

  let bestSplit = -1;
  let bestScore = Infinity;

  let runLen = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    runLen += texts[i].length + (i > 0 ? 1 : 0);
    const bottomLen = totalLen - runLen - 1;

    // Pyramid: top must be ≤ bottom, and both ≤ maxLineChars
    if (runLen > maxLineChars || bottomLen > maxLineChars) continue;
    if (runLen > bottomLen) continue; // violates pyramid

    // Don't break before a clitic (short preposition/conjunction that belongs with next word)
    if (i + 1 < texts.length && NO_BREAK_BEFORE[lang].has(texts[i + 1].toLowerCase().replace(/[.,;:!?]/g, ""))) continue;

    // Score: prefer breaks at phrase boundaries, then closest to ideal split
    let score = Math.abs(runLen - idealTop);
    if (endsWithPunctuation(texts[i])) score -= 20; // strong preference
    if (i + 1 < texts.length && isBreakPoint(texts[i + 1], lang)) score -= 10; // good break point

    if (score < bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  if (bestSplit === -1) return full; // can't split well, keep single line

  const top = texts.slice(0, bestSplit + 1).join(" ");
  const bottom = texts.slice(bestSplit + 1).join(" ");
  return `${top}\n${bottom}`;
}

function captionsToSrt(captions: CaptionWord[], lang: TranscriptionLanguage): string {
  const MAX_LINE_CHARS = 42;
  const MAX_BLOCK_CHARS = 84; // 2 lines
  const MIN_DISPLAY_MS = 1000;
  const MIN_GAP_MS = 80; // ~2 frames at 25fps, so viewer perceives subtitle change
  const SILENCE_GAP_MS = 1000;
  const crlf = "\r\n";

  // Step 1: Group words into subtitle blocks respecting phrase boundaries
  const groups: CaptionWord[][] = [];
  let currentBlock: CaptionWord[] = [];

  for (let wi = 0; wi < captions.length; wi++) {
    const word = captions[wi];
    const prevEnd = currentBlock.length > 0 ? currentBlock[currentBlock.length - 1].endMs : 0;

    // Force break on silence gap
    if (currentBlock.length > 0 && word.startMs - prevEnd > SILENCE_GAP_MS) {
      groups.push(currentBlock);
      currentBlock = [];
    }

    // Check if adding this word would exceed max block size
    const projectedLen = currentBlock.length > 0
      ? blockTextLength(currentBlock) + 1 + word.text.trim().length
      : word.text.trim().length;

    if (currentBlock.length > 0 && projectedLen > MAX_BLOCK_CHARS) {
      groups.push(currentBlock);
      currentBlock = [];
    }

    // Prefer breaking at phrase boundaries when block is getting long enough
    if (currentBlock.length >= 4 && projectedLen > MAX_LINE_CHARS) {
      const prevWord = currentBlock[currentBlock.length - 1].text.trim();
      const currWord = word.text.trim().toLowerCase().replace(/[.,;:!?]/g, "");

      if (endsWithPunctuation(prevWord) || isBreakPoint(currWord, lang)) {
        // Don't break if current word is a clitic that should stay with next word
        if (!NO_BREAK_BEFORE[lang].has(currWord)) {
          groups.push(currentBlock);
          currentBlock = [];
        }
      }
    }

    currentBlock.push(word);
  }
  if (currentBlock.length > 0) {
    groups.push(currentBlock);
  }

  // Step 2: Format SRT with pyramid rule, minimum display time, and inter-subtitle gaps
  let srt = "";
  let index = 1;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const startMs = group[0].startMs;
    let endMs = group[group.length - 1].endMs;

    // Enforce minimum 1s display time
    if (endMs - startMs < MIN_DISPLAY_MS) {
      endMs = startMs + MIN_DISPLAY_MS;
    }

    // Enforce minimum gap: trim end so it doesn't overlap with next subtitle start
    if (gi + 1 < groups.length) {
      const nextStart = groups[gi + 1][0].startMs;
      if (endMs > nextStart - MIN_GAP_MS) {
        endMs = Math.max(startMs + MIN_DISPLAY_MS, nextStart - MIN_GAP_MS);
      }
    }

    const start = msToSrtTimestamp(startMs);
    const end = msToSrtTimestamp(endMs);
    const text = applyPyramidRule(group, MAX_LINE_CHARS, lang);
    srt += `${index}${crlf}${start} --> ${end}${crlf}${text}${crlf}${crlf}`;
    index++;
  }

  return srt;
}

// ... inside alignRoute function ...

  // 5f. Download captions as SRT
  app.get<{ Params: { projectId: string }; Reply: string | ErrorResponse }>(
    "/api/projects/:projectId/captions.srt",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.captions) {
         if (session.transcript) {
            session.captions = wordsToCaptions(session.transcript.words);
         } else {
            return reply.status(400).send({ success: false, error: "No captions available" });
         }
      }

      const lang = await settingsService.getTranscriptionLanguage();
      const srt = captionsToSrt(session.captions, lang);

      return reply
        .header("Content-Type", "application/x-subrip")
        .header("Content-Disposition", 'attachment; filename="captions.srt"')
        .send(srt);
    }
  );

  // 5g. Upload reference script text
  app.post<{
    Params: { projectId: string };
    Body: { scriptText: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/script",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const { scriptText } = (request.body ?? {}) as Partial<{ scriptText: string }>;

      if (!scriptText || typeof scriptText !== "string") {
        return reply.status(400).send({ success: false, error: "scriptText is required" });
      }

      orchestrator.setScriptText(projectId, scriptText);
      return { success: true as const };
    }
  );

  // POST /api/projects/:projectId/run-gemini
  // Trigger Gemini automation on a session already in ALIGNING state
  app.post<{ Params: { projectId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/projects/:projectId/run-gemini",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (session.state !== "ALIGNING") {
        return reply.status(409).send({ success: false, error: `Cannot run Gemini in state: ${session.state}` });
      }
      if (!session.transcript) {
        return reply.status(409).send({ success: false, error: "No transcript available" });
      }

      // Reset progress so the UI shows the automation running
      orchestrator.updateProgress(projectId, 0, "Starting Gemini...");

      // Fire-and-forget — progress events update the client
      runGeminiAutomation(projectId, session.transcript, app.log).catch(() => {});

      return { success: true as const };
    }
  );
}
