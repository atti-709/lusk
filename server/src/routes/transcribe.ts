import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import type { TranscribeRequest, ErrorResponse, TranscriptData, ViralClip } from "@lusk/shared";

function generateMockTranscript(): TranscriptData {
  const words = [
    "Ahoj", "vitajte", "v", "dnešnom", "podcaste",
    "dnes", "si", "povieme", "niečo", "zaujímavé",
    "o", "tom", "ako", "sa", "robí",
    "virálny", "obsah", "na", "sociálnych", "sieťach",
  ];

  let timeMs = 0;
  const transcriptWords = words.map((word) => {
    const startMs = timeMs;
    const duration = 200 + Math.floor(Math.random() * 300);
    timeMs = startMs + duration + 50;
    return { word, startMs, endMs: startMs + duration };
  });

  return {
    words: transcriptWords,
    text: words.join(" "),
  };
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

async function runMockTranscription(sessionId: string): Promise<void> {
  // TRANSCRIBING phase (~3s)
  orchestrator.transition(sessionId, "TRANSCRIBING");
  orchestrator.updateProgress(sessionId, 10, "Loading whisper model...");
  await delay(1000);
  orchestrator.updateProgress(sessionId, 50, "Transcribing audio...");
  await delay(1500);
  orchestrator.updateProgress(sessionId, 90, "Parsing results...");
  await delay(500);

  const transcript = generateMockTranscript();
  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.updateProgress(sessionId, 100, "Transcription complete");

  // ALIGNING phase (~1.5s)
  orchestrator.transition(sessionId, "ALIGNING");
  orchestrator.updateProgress(sessionId, 30, "Aligning text...");
  await delay(800);
  orchestrator.updateProgress(sessionId, 100, "Alignment complete");
  await delay(700);

  // ANALYZING phase (~2s)
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribeRoute(app: FastifyInstance) {
  app.post<{ Body: TranscribeRequest; Reply: { success: true } | ErrorResponse }>(
    "/api/transcribe",
    async (request, reply) => {
      const { sessionId } = request.body ?? {};

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
      runMockTranscription(sessionId).catch((err) => {
        app.log.error(err, "Mock transcription failed");
      });

      return { success: true as const };
    }
  );
}
