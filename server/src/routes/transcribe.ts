import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import { geminiService, wordsToTsv, msToTimestamp } from "../services/GeminiService.js";
import { parseTsv, parseViralClipText, wordsToCaptions } from "./align.js";
import type { TranscribeRequest, ErrorResponse } from "@lusk/shared";

type Logger = Pick<FastifyInstance["log"], "error">;

/** Active transcription abort controllers, keyed by sessionId. */
const activeTranscriptions = new Map<string, AbortController>();

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
    let tsvForClips: string;

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

      // Parse and apply corrected transcript
      const last = rawTranscript.words.at(-1);
      const fallbackEndMs = last ? last.endMs : 0;
      const correctedWords = parseTsv(correctedTsv, fallbackEndMs);

      orchestrator.setTranscript(sessionId, { text: "", words: correctedWords });
      orchestrator.setCorrectedTranscriptRaw(sessionId, correctedTsv);
      orchestrator.setCaptions(sessionId, wordsToCaptions(correctedWords));

      tsvForClips = correctedTsv;
    } else {
      // No script — use raw transcript TSV directly
      tsvForClips = wordsToTsv(rawTranscript.words);
      orchestrator.setCorrectedTranscriptRaw(sessionId, tsvForClips);
      orchestrator.updateProgress(sessionId, 5, "Starting Gemini viral clip detection...");
    }

    // 2. Detect viral clips
    const lastWord = rawTranscript.words.at(-1);
    const transcriptEndMs = lastWord ? lastWord.endMs : 0;
    const lastTimestamp = msToTimestamp(transcriptEndMs);

    const viralClipText = await geminiService.detectViralClips(
      tsvForClips,
      lastTimestamp,
      (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
      signal,
    );

    const rawClips = viralClipText.trim() ? parseViralClipText(viralClipText) : [];

    // Filter out clips with invalid time ranges
    const clips = rawClips.filter(c => {
      if (c.startMs < 0 || c.endMs <= c.startMs) return false;
      if (c.endMs > transcriptEndMs) return false;
      return true;
    });
    if (clips.length < rawClips.length) {
      console.log(`[runGeminiAutomation] Filtered out ${rawClips.length - clips.length} clips exceeding transcript duration (${lastTimestamp})`);
    }

    orchestrator.setViralClips(sessionId, clips);

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

async function runTranscription(sessionId: string, log: Logger): Promise<void> {
  const controller = new AbortController();
  activeTranscriptions.set(sessionId, controller);

  orchestrator.transition(sessionId, "TRANSCRIBING");
  try {
    await doTranscribe(sessionId, log, controller.signal);
  } catch (err: any) {
    if (controller.signal.aborted) {
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

  app.post<{ Params: { projectId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/projects/:projectId/cancel",
    async (request, reply) => {
      const { projectId } = request.params;

      const controller = activeTranscriptions.get(projectId);
      if (!controller) {
        return reply.send({ success: true }); // nothing to cancel
      }

      controller.abort();
      return reply.send({ success: true });
    }
  );
}
