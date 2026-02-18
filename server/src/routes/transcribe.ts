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

  // Phase 2: Alignment (only if source script was provided)
  orchestrator.transition(sessionId, "ALIGNING");

  if (session.sourceScript) {
    orchestrator.updateProgress(sessionId, 20, "Aligning with source text...");

    const aligned = alignTranscript(transcript, session.sourceScript);
    orchestrator.setTranscript(sessionId, aligned);

    await writeFile(
      join(sessionDir, "aligned-transcript.json"),
      JSON.stringify(aligned, null, 2)
    );

    orchestrator.updateProgress(sessionId, 100, "Alignment complete");
  } else {
    orchestrator.updateProgress(sessionId, 100, "No source script — skipping alignment");
  }

  // Phase 3: Viral clip detection via LLM
  orchestrator.transition(sessionId, "ANALYZING");

  const currentTranscript = orchestrator.getSession(sessionId)!.transcript!;

  try {
    const clips = await llmService.findViralClips(
      currentTranscript,
      sessionDir,
      (percent, message) => {
        orchestrator.updateProgress(sessionId, percent, message);
      }
    );

    orchestrator.setViralClips(sessionId, clips);
  } catch (err) {
    app.log.warn(err, "LLM viral detection failed, using empty clips");
    orchestrator.setViralClips(sessionId, []);
    orchestrator.updateProgress(sessionId, 100, "LLM unavailable — skipping clip detection");
  }

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
