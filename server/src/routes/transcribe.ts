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

  // Phase 2: Alignment (optional)
  // We must transition ensuring the orchestrator state machine is satisfied
  orchestrator.transition(sessionId, "ALIGNING");

  if (session.sourceScript) {
    orchestrator.updateProgress(sessionId, 0, "Aligning with source text...");

    try {
      const alignedTranscript = alignTranscript(
        transcript,
        session.sourceScript
      );
      
      // Update transcript with aligned version
      orchestrator.setTranscript(sessionId, alignedTranscript);
      
      // Update captions from aligned transcript
      // We need to map TranscriptData back to CaptionWord[]
      // For now, we reuse the timestamp structure but use corrected words
      const alignedCaptions = alignedTranscript.words.map(w => ({
        text: w.word,
        startMs: w.startMs,
        endMs: w.endMs,
        timestampMs: w.startMs,
        confidence: 1.0 // Aligned words are considered high confidence
      }));
      
      orchestrator.setCaptions(sessionId, alignedCaptions);
      orchestrator.updateProgress(sessionId, 100, "Alignment complete");
    } catch (err) {
      console.error("Alignment failed, proceeding with original transcript", err);
    }
  }

  // Phase 3: Analysis (LLM)
  orchestrator.transition(sessionId, "ANALYZING");
  
  // Use aligned transcript if available, otherwise original
  const currentTranscript = session.sourceScript 
    ? orchestrator.getSession(sessionId)?.transcript ?? transcript 
    : transcript;

  try {
    const viralClips = await llmService.findViralClips(
      currentTranscript,
      sessionDir,
      (percent, message) => {
        orchestrator.updateProgress(sessionId, percent, message);
      }
    );
    orchestrator.setViralClips(sessionId, viralClips);
  } catch (err) {
    console.error("Analysis failed", err);
    orchestrator.setViralClips(sessionId, []);
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
