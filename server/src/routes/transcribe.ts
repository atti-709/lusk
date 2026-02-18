import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import { whisperService } from "../services/WhisperService.js";
import { tempManager } from "../services/TempManager.js";
import type { TranscribeRequest, ErrorResponse, ViralClip } from "@lusk/shared";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateMockViralClips(): ViralClip[] {
  return [
    {
      title: "Virálny hook #1",
      startMs: 0,
      endMs: 15000,
      hookText: "Ako sa robí virálny obsah?",
    },
    {
      title: "Virálny hook #2",
      startMs: 5000,
      endMs: 20000,
      hookText: "Sociálne siete a ich tajomstvá",
    },
  ];
}

async function runTranscription(sessionId: string, app: FastifyInstance): Promise<void> {
  const sessionDir = tempManager.getSessionDir(sessionId);

  // Phase 1: Real transcription via whisper.cpp
  orchestrator.transition(sessionId, "TRANSCRIBING");

  const { transcript, captions } = await whisperService.transcribe(
    sessionDir,
    (percent, message) => {
      orchestrator.updateProgress(sessionId, percent, message);
    }
  );

  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.setCaptions(sessionId, captions);

  // Phase 2: Alignment (still mock — Phase 3)
  orchestrator.transition(sessionId, "ALIGNING");
  orchestrator.updateProgress(sessionId, 30, "Aligning text...");
  await delay(800);
  orchestrator.updateProgress(sessionId, 100, "Alignment complete");
  await delay(700);

  // Phase 3: Viral clip detection (still mock — Phase 3)
  orchestrator.transition(sessionId, "ANALYZING");
  orchestrator.updateProgress(sessionId, 20, "Loading LLM...");
  await delay(1000);
  orchestrator.updateProgress(sessionId, 60, "Finding viral hooks...");
  await delay(800);

  const clips = generateMockViralClips();
  orchestrator.setViralClips(sessionId, clips);
  orchestrator.updateProgress(sessionId, 100, "Analysis complete");
  await delay(200);

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
        app.log.error(err, "Transcription failed");
      });

      return { success: true as const };
    }
  );
}
