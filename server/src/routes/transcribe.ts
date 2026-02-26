import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import type { TranscribeRequest, ErrorResponse } from "@lusk/shared";

type Logger = Pick<FastifyInstance["log"], "error">;

/**
 * Core transcription work — does not perform the UPLOADING→TRANSCRIBING
 * transition so it can be called both from the HTTP handler (which does the
 * transition first) and from server startup (session already in TRANSCRIBING).
 */
export async function doTranscribe(sessionId: string, log: Logger): Promise<void> {
  const sessionDir = tempManager.getSessionDir(sessionId);

  orchestrator.updateProgress(sessionId, 0, "Starting transcription...");

  const { transcript, captions } = await whisperService.transcribe(
    sessionDir,
    (percent, message) => {
      orchestrator.updateProgress(sessionId, percent, message);
    }
  );

  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.setCaptions(sessionId, captions);

  orchestrator.transition(sessionId, "ALIGNING");
  orchestrator.updateProgress(sessionId, 100, "Transcript ready — download and correct with Gemini");
}

async function runTranscription(sessionId: string, log: Logger): Promise<void> {
  orchestrator.transition(sessionId, "TRANSCRIBING");
  try {
    await doTranscribe(sessionId, log);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    log.error(err, "Transcription pipeline failed");
    // Surface the error to the user in the UI
    orchestrator.updateProgress(sessionId, -1, `Error: ${message}`);
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
}
