import { FastifyInstance } from "fastify";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import { alignTranscript } from "../services/AlignmentService.js";
import { llmService } from "../services/LlmService.js";
import type { TranscribeRequest, ErrorResponse } from "@lusk/shared";

async function runTranscription(sessionId: string, app: FastifyInstance): Promise<void> {
  const sessionDir = tempManager.getSessionDir(sessionId);
  const session = orchestrator.getSession(sessionId)!;

  // Phase 1: Transcription via whisper.cpp
  orchestrator.transition(sessionId, "TRANSCRIBING");

  const { transcript, captions } = await whisperService.transcribe(
    sessionDir,
    (percent, message) => {
      orchestrator.updateProgress(sessionId, percent, message);
    }
  );

  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.setCaptions(sessionId, captions);

  // Phase 2 & 3: Alignment + LLM (skipped for now)
  // Walk through required states so the orchestrator doesn't reject the transition
  orchestrator.transition(sessionId, "ALIGNING");
  orchestrator.transition(sessionId, "ANALYZING");
  orchestrator.setViralClips(sessionId, []);

  // Transition to READY
  orchestrator.transition(sessionId, "READY");
  orchestrator.updateProgress(sessionId, 100, "Ready to render");
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
      runTranscription(sessionId, app).catch((err) => {
        app.log.error(err, "Transcription pipeline failed");
      });

      return { success: true as const };
    }
  );
}
