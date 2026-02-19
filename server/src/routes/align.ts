import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import type { ErrorResponse, TranscriptWord, ViralClip, CaptionWord } from "@lusk/shared";

// ── Helpers ──

function msToTimestamp(ms: number): string {
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function timestampToMs(ts: string): number {
  const parts = ts.split(":");
  if (parts.length !== 3) throw new Error(`Invalid timestamp: ${ts}`);
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return Math.round((h * 3600 + m * 60 + s) * 1000);
}

function wordsToTsv(words: TranscriptWord[]): string {
  return words.map((w) => `${msToTimestamp(w.startMs)}\t${w.word}`).join("\n");
}

function parseTsv(tsv: string, fallbackEndMs: number): TranscriptWord[] {
  const lines = tsv.trim().split("\n").filter((l) => l.trim());
  const words: TranscriptWord[] = [];
  for (const line of lines) {
    const [timestamp, ...rest] = line.split("\t");
    const word = rest.join("\t").trim();
    if (!timestamp || !word) continue;
    words.push({ word, startMs: timestampToMs(timestamp.trim()), endMs: 0 });
  }
  // Compute endMs: next word's startMs, last word uses fallbackEndMs
  for (let i = 0; i < words.length; i++) {
    words[i].endMs = i < words.length - 1 ? words[i + 1].startMs : fallbackEndMs;
  }
  return words;
}

function parseViralClipText(text: string): ViralClip[] {
  const clips: ViralClip[] = [];
  // Split on "CLIP N" headers
  const blocks = text.split(/^CLIP\s+\d+/im).filter((b) => b.trim());

  for (const block of blocks) {
    const titleMatch = block.match(/Title:\s*(.+)/i);
    const hookMatch = block.match(/Hook:\s*(.+)/i);
    const startMatch = block.match(/Start:\s*(\S+)/i);
    const endMatch = block.match(/End:\s*(\S+)/i);

    if (startMatch && endMatch) {
      clips.push({
        title: titleMatch?.[1]?.trim() ?? "Untitled",
        hookText: hookMatch?.[1]?.trim() ?? "",
        startMs: timestampToMs(startMatch[1]),
        endMs: timestampToMs(endMatch[1]),
      });
    }
  }
  return clips;
}

function wordsToCaptions(words: TranscriptWord[]): CaptionWord[] {
  return words.map((w, i) => ({
    text: i === 0 ? w.word : ` ${w.word}`,
    startMs: w.startMs,
    endMs: w.endMs,
    timestampMs: w.startMs,
    confidence: null,
  }));
}

// ── Routes ──

export async function alignRoute(app: FastifyInstance) {
  // 5a. Download transcript as TSV
  app.get<{ Params: { sessionId: string }; Reply: string | ErrorResponse }>(
    "/api/project/:sessionId/transcript.tsv",
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = orchestrator.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.transcript) {
        return reply.status(400).send({ success: false, error: "No transcript available" });
      }

      const tsv = wordsToTsv(session.transcript.words);
      return reply
        .header("Content-Type", "text/tab-separated-values")
        .header("Content-Disposition", 'attachment; filename="transcription.tsv"')
        .send(tsv);
    }
  );

  // 5b. Upload corrected transcript
  app.post<{
    Params: { sessionId: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/project/:sessionId/corrected-transcript",
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = orchestrator.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.transcript) {
        return reply.status(400).send({ success: false, error: "No transcript to correct" });
      }

      // Accept raw text body (TSV content)
      const rawBody = typeof request.body === "string"
        ? request.body
        : (request.body as { text?: string })?.text;

      if (!rawBody || typeof rawBody !== "string") {
        return reply.status(400).send({ success: false, error: "TSV text is required" });
      }

      try {
        const lastWord = session.transcript.words.at(-1);
        const fallbackEndMs = lastWord ? lastWord.endMs : 0;
        const correctedWords = parseTsv(rawBody, fallbackEndMs);

        const correctedTranscript = {
          words: correctedWords,
        };

        orchestrator.setTranscript(sessionId, correctedTranscript);
        orchestrator.setCaptions(sessionId, wordsToCaptions(correctedWords));

        return { success: true as const };
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: `Failed to parse TSV: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  );

  // 5c. Submit viral clips (parsed from Gemini text output)
  app.post<{
    Params: { sessionId: string };
    Body: { text: string };
    Reply: { success: true; clips: ViralClip[] } | ErrorResponse;
  }>(
    "/api/project/:sessionId/viral-clips",
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = orchestrator.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const { text } = (request.body ?? {}) as Partial<{ text: string }>;
      if (!text || typeof text !== "string") {
        return reply.status(400).send({ success: false, error: "text is required" });
      }

      try {
        const clips = parseViralClipText(text);
        if (clips.length === 0) {
          return reply.status(400).send({ success: false, error: "No clips could be parsed from the text" });
        }

        orchestrator.setViralClips(sessionId, clips);

        // Regenerate captions from (possibly corrected) transcript
        if (session.transcript) {
          orchestrator.setCaptions(sessionId, wordsToCaptions(session.transcript.words));
        }

        orchestrator.transition(sessionId, "READY");
        orchestrator.updateProgress(sessionId, 100, "Ready to review");

        return { success: true as const, clips };
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: `Failed to parse clips: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  );
}
