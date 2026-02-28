import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import { geminiService } from "../services/GeminiService.js";
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
  orchestrator.setCaptions(sessionId, captions);

  orchestrator.transition(sessionId, "ALIGNING");

  // Auto-run Gemini correction + viral clip detection if script and API key are available
  const session = orchestrator.getSession(sessionId);
  const hasScript = !!session?.scriptText;
  const geminiAvailable = await geminiService.isAvailable();

  if (hasScript && geminiAvailable && session) {
    try {
      orchestrator.updateProgress(sessionId, 5, "Starting Gemini correction...");

      // 1. Correct transcript
      const correctedTsv = await geminiService.correctTranscript(
        transcript.words,
        session.scriptText!,
        (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
        signal,
      );

      // Parse and apply corrected transcript
      const lastWord = transcript.words.at(-1);
      const fallbackEndMs = lastWord ? lastWord.endMs : 0;
      const correctedWords = parseTsv(correctedTsv, fallbackEndMs);
      const correctedTranscript = { text: "", words: correctedWords };

      orchestrator.setTranscript(sessionId, correctedTranscript);
      orchestrator.setCorrectedTranscriptRaw(sessionId, correctedTsv);
      orchestrator.setCaptions(sessionId, wordsToCaptions(correctedWords));

      // 2. Detect viral clips
      const viralClipText = await geminiService.detectViralClips(
        correctedTsv,
        (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
        signal,
      );

      const clips = viralClipText.trim() ? parseViralClipText(viralClipText) : [];
      orchestrator.setViralClips(sessionId, clips);

      // Transition to READY
      orchestrator.transition(sessionId, "READY");
      orchestrator.updateProgress(sessionId, 100, "Ready to review");
    } catch (err: any) {
      if (signal?.aborted) throw err; // re-throw cancellation
      // Gemini failed — stay in ALIGNING for manual fallback
      log.error(err, "Gemini automation failed, falling back to manual");
      orchestrator.updateProgress(sessionId, 100, "Gemini failed — use manual workflow below");
    }
  } else {
    // No script or no API key — manual workflow
    orchestrator.updateProgress(sessionId, 100, "Transcript ready — download and correct with Gemini");
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

  app.post<{ Body: { sessionId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/transcribe/cancel",
    async (request, reply) => {
      const { sessionId } = request.body ?? {};

      const controller = activeTranscriptions.get(sessionId);
      if (!controller) {
        return reply.send({ success: true }); // nothing to cancel
      }

      controller.abort();
      return reply.send({ success: true });
    }
  );
}
