import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import { geminiService, wordsToTsv, msToTimestamp } from "../services/GeminiService.js";
import { settingsService } from "../services/SettingsService.js";
import { parseTsv, wordsToCaptions, groupCaptionBlocks, geminiClipsToViralClips } from "./align.js";
import type { TranscribeRequest, ErrorResponse, ViralClip, TranscriptWord, TranslatedBlock } from "@lusk/shared";

type Logger = Pick<FastifyInstance["log"], "error">;

export const GEMINI_CANCELLED = "Gemini cancelled — run it again or use the manual workflow below";

/** Active transcription abort controllers, keyed by sessionId. */
const activeTranscriptions = new Map<string, AbortController>();

/** Active Gemini automation abort controllers (from manual "Run Gemini"), keyed by sessionId. */
export const activeGeminiOperations = new Map<string, AbortController>();

/**
 * Core transcription work — does not perform the UPLOADING→TRANSCRIBING
 * transition so it can be called both from the HTTP handler (which does the
 * transition first) and from server startup (session already in TRANSCRIBING).
 */
export async function doTranscribe(sessionId: string, log: Logger, signal?: AbortSignal): Promise<void> {
  const sessionDir = tempManager.getSessionDir(sessionId);

  orchestrator.updateProgress(sessionId, 0, "Starting transcription...");

  const { transcript, captions } = await whisperService.transcribe(
    sessionDir,
    (percent, message) => {
      orchestrator.updateProgress(sessionId, percent, message);
    },
    signal,
  );

  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.setOriginalTranscript(sessionId, transcript);
  orchestrator.setCaptions(sessionId, captions);

  orchestrator.transition(sessionId, "ALIGNING");

  const geminiAvailable = await geminiService.isAvailable();
  if (geminiAvailable) {
    const original = orchestrator.getSession(sessionId)?.originalTranscript ?? transcript;
    await runGeminiAutomation(sessionId, original, log, signal);
  } else {
    // No API key — manual workflow
    orchestrator.updateProgress(sessionId, 100, "No Gemini API key — use manual workflow below");
  }
}

/**
 * Run the Gemini automation pipeline on a session that is already in ALIGNING state.
 * - If the session has a script: correct transcript, then detect viral clips.
 * - If no script: detect viral clips from the raw transcript directly.
 * On success transitions to READY. On failure stays in ALIGNING at progress=100 for manual fallback.
 */
export async function runGeminiAutomation(
  sessionId: string,
  rawTranscript: { words: { word: string; startMs: number; endMs: number }[] },
  log: Logger,
  signal?: AbortSignal
): Promise<void> {
  const session = orchestrator.getSession(sessionId);
  if (!session) return;

  try {
    let words: TranscriptWord[];

    if (session.scriptText) {
      orchestrator.updateProgress(sessionId, 5, "Starting Gemini correction...");

      // 1. Correct transcript using script
      const correctedTsv = await geminiService.correctTranscript(
        rawTranscript.words,
        session.scriptText,
        sessionId,
        (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
        signal,
      );

      const last = rawTranscript.words.at(-1);
      const fallbackEndMs = last ? last.endMs : 0;
      words = parseTsv(correctedTsv, fallbackEndMs, rawTranscript.words);
    } else {
      words = rawTranscript.words;
      orchestrator.updateProgress(sessionId, 5, "Starting Gemini proofreading...");
    }

    // 2. Proofread: a sparse word-level pass that catches what the row-for-row
    //    correction misses (and is the only correction a script-less project gets)
    words = await proofread(sessionId, words, session.scriptText ?? null, signal);

    const tsvForClips = wordsToTsv(words);
    orchestrator.setTranscript(sessionId, { text: "", words });
    orchestrator.setCorrectedTranscriptRaw(sessionId, tsvForClips);
    orchestrator.setCaptions(sessionId, wordsToCaptions(words));

    // 3. Detect viral clips
    const transcriptEndMs = rawTranscript.words.at(-1)?.endMs ?? 0;
    const clips = await detectClips(sessionId, tsvForClips, words, transcriptEndMs, signal);
    orchestrator.setViralClips(sessionId, clips);

    // 4. Translate captions to English (if source language is not English)
    try {
      await translateCaptions(sessionId, signal);
    } catch (err: any) {
      if (signal?.aborted) throw err;
      console.warn("[runGeminiAutomation] Translation failed, continuing without:", err?.message);
    }

    // Transition to READY
    orchestrator.transition(sessionId, "READY");
    orchestrator.updateProgress(sessionId, 100, "Ready to review");
  } catch (err: any) {
    if (signal?.aborted) throw err; // re-throw cancellation
    log.error(err, "Gemini automation failed, falling back to manual");
    const reason = err?.message?.includes("503") || err?.message?.includes("UNAVAILABLE")
      ? "Gemini is overloaded (503) — try again later or use manual workflow"
      : err?.message?.includes("Chunk validation")
        ? "Gemini returned wrong row count — try again or use manual workflow"
        : "Gemini failed — use manual workflow below";
    orchestrator.updateProgress(sessionId, 100, reason);
  }
}

/**
 * Translate the session's captions to English, caption block by caption block, into
 * `translatedCaptions` (the English SRT). Nothing to do for an English transcript.
 */
async function translateCaptions(sessionId: string, signal?: AbortSignal): Promise<void> {
  const lang = await settingsService.getTranscriptionLanguage();
  const captions = orchestrator.getSession(sessionId)?.captions;
  if (lang === "en" || !captions || captions.length === 0) return;

  const blockTexts = groupCaptionBlocks(captions, lang).map((group) => ({
    text: group.map((w) => w.text.trim()).join(" "),
    startMs: group[0].startMs,
    endMs: group[group.length - 1].endMs,
  }));
  const translated = await geminiService.translateCaptions(
    blockTexts,
    lang,
    sessionId,
    (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
    signal,
  );
  // A line Gemini merged into the one before is covered by that line's text
  const blocks: TranslatedBlock[] = [];
  blockTexts.forEach((b, i) => {
    const prev = blocks.at(-1);
    if (translated[i]) blocks.push({ text: translated[i], startMs: b.startMs, endMs: b.endMs });
    else if (prev) prev.endMs = b.endMs;
  });
  orchestrator.setTranslatedCaptions(sessionId, blocks);
}

/**
 * Proofread the transcript with Gemini. Never fatal: a failed pass logs and leaves the
 * transcript as it was, since everything downstream works without it.
 */
async function proofread(
  sessionId: string,
  words: TranscriptWord[],
  scriptText: string | null,
  signal?: AbortSignal,
): Promise<TranscriptWord[]> {
  try {
    const lang = await settingsService.getTranscriptionLanguage();
    const result = await geminiService.proofreadTranscript(
      words,
      scriptText,
      lang,
      sessionId,
      (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
      signal,
    );
    for (const e of result.applied) {
      console.log(`[proofread] ${msToTimestamp(e.atMs)}  "${e.from}" → "${e.to}"${e.reason ? `  (${e.reason})` : ""}`);
    }
    if (result.rejected.length) {
      console.log(`[proofread] dropped ${result.rejected.length} edit(s) that didn't match the transcript:`, JSON.stringify(result.rejected));
    }
    orchestrator.updateProgress(sessionId, 85, `Proofread fixed ${result.applied.length} word${result.applied.length === 1 ? "" : "s"}`);
    return result.words;
  } catch (err: any) {
    if (signal?.aborted) throw err;
    console.warn("[proofread] failed, continuing without:", err?.message);
    return words;
  }
}

/** Ask Gemini for clips and resolve them against the transcript's words. */
async function detectClips(
  sessionId: string,
  tsv: string,
  words: TranscriptWord[],
  transcriptEndMs: number,
  signal?: AbortSignal,
): Promise<ViralClip[]> {
  const lastTimestamp = msToTimestamp(transcriptEndMs);
  const raw = await geminiService.detectViralClips(
    tsv,
    lastTimestamp,
    (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
    signal,
  );
  const clips = geminiClipsToViralClips(raw, words, transcriptEndMs);
  if (clips.length < raw.length) {
    console.log(`[detectClips] Dropped ${raw.length - clips.length} clip(s) with invalid time ranges (transcript ends ${lastTimestamp})`);
  }
  return clips;
}

/**
 * Re-run only the viral clip detection for a session that is already in READY.
 * Reuses the previously corrected transcript (never re-runs correction, to avoid
 * drift) and replaces the session's viral clips with a fresh Gemini suggestion.
 * The session stays in READY throughout. Returns the new clips; throws on failure
 * or cancellation.
 */
export async function regenerateViralClips(
  sessionId: string,
  log: Logger,
  signal?: AbortSignal
): Promise<ViralClip[]> {
  const session = orchestrator.getSession(sessionId);
  if (!session) throw new Error("Session not found");

  orchestrator.updateProgress(sessionId, 5, "Regenerating clips with Gemini...");

  // Prefer the transcript TSV used previously for clip detection; fall back to
  // building it from the current transcript words.
  const words = session.transcript?.words ?? [];
  const tsvForClips = session.correctedTranscriptRaw ?? wordsToTsv(words);

  const lastWord = words.at(-1);
  const wordsEndMs = lastWord ? lastWord.endMs : 0;
  // Upper bound for validating clip ranges. Prefer the transcript's last word,
  // fall back to the probed video duration. If neither is known, skip the
  // upper-bound check entirely rather than filtering everything out.
  const transcriptEndMs = Math.max(wordsEndMs, session.videoDurationMs ?? 0);

  try {
    const clips = await detectClips(sessionId, tsvForClips, words, transcriptEndMs, signal);

    // Never destroy the user's existing clips on an empty/failed suggestion —
    // an empty Gemini response (blocked/rate-limited/parse failure) would
    // otherwise silently wipe every clip. Fail loudly and keep what we had.
    if (clips.length === 0) {
      orchestrator.updateProgress(sessionId, 100, "Ready to review");
      throw new Error("Gemini returned no usable clips — try again");
    }

    orchestrator.setViralClips(sessionId, clips);
    orchestrator.updateProgress(sessionId, 100, `Regenerated ${clips.length} clip${clips.length === 1 ? "" : "s"}`);

    return clips;
  } catch (err: any) {
    if (signal?.aborted) throw err; // re-throw cancellation
    log.error(err, "Clip regeneration failed");
    orchestrator.updateProgress(sessionId, 100, "Ready to review");
    throw err;
  }
}

async function runTranscription(sessionId: string, log: Logger): Promise<void> {
  const controller = new AbortController();
  activeTranscriptions.set(sessionId, controller);

  orchestrator.transition(sessionId, "TRANSCRIBING");
  try {
    await doTranscribe(sessionId, log, controller.signal);
  } catch (err: any) {
    if (controller.signal.aborted) {
      if (orchestrator.getSession(sessionId)?.state === "ALIGNING") {
        // Cancelled during the Gemini steps: the transcript is done and kept
        orchestrator.updateProgress(sessionId, 100, GEMINI_CANCELLED);
        return;
      }
      // Cancelled — revert to UPLOADING so the user can retry
      orchestrator.transition(sessionId, "UPLOADING");
      orchestrator.updateProgress(sessionId, 0, "Transcription cancelled");
      return;
    }
    const message = err?.message ?? String(err);
    log.error(err, "Transcription pipeline failed");
    orchestrator.updateProgress(sessionId, -1, `Error: ${message}`);
  } finally {
    activeTranscriptions.delete(sessionId);
  }
}

/** Abort every transcription and Gemini job (server shutdown). */
export function abortAllJobs(): void {
  for (const c of activeTranscriptions.values()) c.abort();
  for (const c of activeGeminiOperations.values()) c.abort();
}

export async function transcribeRoute(app: FastifyInstance) {
  app.post<{ Body: TranscribeRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/transcribe",
    async (request, reply) => {
      const { sessionId } = (request.body ?? {}) as Partial<TranscribeRequest>;

      if (!sessionId) {
        return reply.status(400).send({ success: false, error: "sessionId is required" });
      }

      const session = orchestrator.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      if (session.state !== "UPLOADING") {
        return reply
          .status(409)
          .send({ success: false, error: `Cannot transcribe in state: ${session.state}` });
      }

      // Fire-and-forget — errors are reported to the user via progress events
      runTranscription(sessionId, app.log).catch(() => {});

      return { success: true as const };
    }
  );

  // Translate a ready project's captions to English again — a run whose translation
  // failed (the rest of it is kept) gets its English SRT without redoing anything else
  app.post<{ Params: { projectId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/projects/:projectId/translate",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);
      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (session.state !== "READY") {
        return reply.status(409).send({ success: false, error: `Cannot translate in state: ${session.state}` });
      }
      try {
        await translateCaptions(projectId);
      } catch (err: any) {
        return reply.status(502).send({ success: false, error: err?.message ?? "Translation failed" });
      } finally {
        orchestrator.updateProgress(projectId, 100, "Ready to review");
      }
      return { success: true as const };
    }
  );

  app.post<{ Params: { projectId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/projects/:projectId/cancel",
    async (request, reply) => {
      const { projectId } = request.params;

      const transcription = activeTranscriptions.get(projectId);
      const gemini = activeGeminiOperations.get(projectId);

      request.log.info({ projectId, hasTranscription: !!transcription, hasGemini: !!gemini }, "Cancel requested");

      if (transcription) transcription.abort();
      if (gemini) gemini.abort();

      return reply.send({ success: true });
    }
  );
}
