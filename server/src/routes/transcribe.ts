import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import type { TranscribeRequest, ErrorResponse } from "@lusk/shared";

async function runTranscription(sessionId: string, log: FastifyInstance["log"]): Promise<void> {
  const sessionDir = tempManager.getSessionDir(sessionId);

  orchestrator.transition(sessionId, "TRANSCRIBING");

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

      // Fire-and-forget
      runTranscription(sessionId, app.log).catch((err) => {
        app.log.error(err, "Transcription pipeline failed");
      });

      return { success: true as const };
    }
  );
}
