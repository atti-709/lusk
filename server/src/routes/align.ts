import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import archiver from "archiver";
import type { ErrorResponse, TranscriptWord, ViralClip, CaptionWord } from "@lusk/shared";
import { runGeminiAutomation } from "./transcribe.js";

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
  if (parts.length === 3) {
    // HH:MM:SS.mmm
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const s = parseFloat(parts[2]);
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  }
  if (parts.length === 2) {
    // MM:SS.mmm (Gemini sometimes abbreviates 00:00:11.260 as 00:11.260)
    const m = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    return Math.round((m * 60 + s) * 1000);
  }
  throw new Error(`Invalid timestamp: ${ts}`);
}

function wordsToTsv(words: TranscriptWord[]): string {
  return words.map((w) => `${msToTimestamp(w.startMs)}\t${w.word}`).join("\n");
}

export function parseTsv(tsv: string, fallbackEndMs: number): TranscriptWord[] {
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

export function parseViralClipText(text: string): ViralClip[] {
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

export function wordsToCaptions(words: TranscriptWord[]): CaptionWord[] {
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
  app.get<{ Params: { projectId: string }; Reply: string | ErrorResponse | unknown }>(
    "/api/projects/:projectId/transcript.tsv",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.transcript) {
        return reply.status(400).send({ success: false, error: "No transcript available" });
      }

      const tsv = wordsToTsv(session.transcript.words);
      const lines = tsv.split("\n");

      // If short enough, download as single file
      if (lines.length <= 2000) {
        return reply
          .header("Content-Type", "text/tab-separated-values")
          .header("Content-Disposition", 'attachment; filename="transcription.tsv"')
          .send(tsv);
      }

      // Otherwise, create a zip with chunks
      const archive = archiver("zip", {
        zlib: { level: 9 }, // Sets the compression level.
      });

      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", 'attachment; filename="transcription_chunked.zip"');

      // Pipe archive data to the response
      // Fastify handles streams if we return the stream in send()
      // However, archiver needs to be finalized.
      
      archive.on("error", (err: unknown) => {
        throw err;
      });

      // 1. Add full transcript
      archive.append(tsv, { name: "transcription_full.tsv" });

      // 2. Add chunks
      const CHUNK_SIZE = 2000;
      let part = 1;
      for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        const chunk = lines.slice(i, i + CHUNK_SIZE).join("\n");
        archive.append(chunk, { name: `transcription_part_${part}.tsv` });
        part++;
      }

      // Finalize the archive (this indicates we are done appending)
      archive.finalize();

      return reply.send(archive);
    }
  );

  // 5b. Upload corrected transcript
  app.post<{
    Params: { projectId: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/corrected-transcript",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

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

      // If text is empty/just whitespace or not provided, assume the user deleted the text
      // to revert back to the original transcript.
      if (!rawBody || !rawBody.trim()) {
        try {
          if (session.originalTranscript) {
             orchestrator.setTranscript(projectId, session.originalTranscript);
             orchestrator.setCaptions(projectId, wordsToCaptions(session.originalTranscript.words));
          }
          orchestrator.setCorrectedTranscriptRaw(projectId, "");
          return { success: true as const };
        } catch (err) {
           return reply.status(400).send({
              success: false,
              error: `Failed to restore original transcript: ${err instanceof Error ? err.message : String(err)}`,
           });
        }
      }

      try {
        const lastWord = session.transcript.words.at(-1);
        const fallbackEndMs = lastWord ? lastWord.endMs : 0;
        const correctedWords = parseTsv(rawBody, fallbackEndMs);

        const correctedTranscript = {
          text: "", // TODO: Reconstruct if needed, but for alignment words are key
          words: correctedWords,
        };

        orchestrator.setTranscript(projectId, correctedTranscript);
        orchestrator.setCorrectedTranscriptRaw(projectId, rawBody);
        orchestrator.setCaptions(projectId, wordsToCaptions(correctedWords));

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
    Params: { projectId: string };
    Body: { text: string };
    Reply: { success: true; clips: ViralClip[] } | ErrorResponse;
  }>(
    "/api/projects/:projectId/viral-clips",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const { text } = (request.body ?? {}) as Partial<{ text: string }>;

      try {
        // Empty text means "skip viral clip detection" — proceed to READY with 0 clips
        const clips = text?.trim() ? parseViralClipText(text) : [];

        orchestrator.setViralClips(projectId, clips);

        // Regenerate captions from (possibly corrected) transcript
        if (session.transcript) {
          orchestrator.setCaptions(projectId, wordsToCaptions(session.transcript.words));
        }

        orchestrator.transition(projectId, "READY");
        orchestrator.updateProgress(projectId, 100, "Ready to review");

        return { success: true as const, clips };
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: `Failed to parse clips: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  );

  // 5d. Add a single clip manually
  app.post<{
    Params: { projectId: string };
    Body: ViralClip;
    Reply: { success: true; clips: ViralClip[] } | ErrorResponse;
  }>(
    "/api/projects/:projectId/clips",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const clip = request.body as ViralClip;
      if (clip.startMs == null || clip.endMs == null || clip.endMs <= clip.startMs) {
        return reply.status(400).send({ success: false, error: "Invalid start/end times" });
      }

      const existing = session.viralClips ?? [];
      const updated = [...existing, clip];
      orchestrator.setViralClips(projectId, updated);

      return { success: true as const, clips: updated };
    }
  );

  // 5e. Go back to align step from READY
  app.post<{
    Params: { projectId: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/back-to-align",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      try {
        orchestrator.transition(projectId, "ALIGNING");
        orchestrator.updateProgress(projectId, 100, "Modify transcript or clips");
        return { success: true as const };
      } catch (err) {
        return reply.status(409).send({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
// Helper to format SRT timestamp: HH:MM:SS,mmm
function msToSrtTimestamp(ms: number): string {
  const date = new Date(ms);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  const msStr = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s},${msStr}`;
}

function captionsToSrt(captions: CaptionWord[]): string {
  let srt = "";
  let index = 1;
  const GROUP_SIZE = 4000; // ~4 seconds per subtitle block? 
  // Wait, `CaptionWord` is word-level. We need to group them into sentences or meaningful blocks for SRT?
  // User just said "corrected subtitles for youtube". YouTube handles SRTs well.
  // If we just dump 1 word per line it's terrible.
  // BUT the "captions" we have in `orchestrator` are `CaptionWord[]`.
  // We need to group them.
  // Actually, let's keep it simple: group by ~3-5 seconds or sentence endings?
  // Ideally, we'd use the original `Whisper` segments if we had them. But we only have words.
  // Let's implement a simple greedy packer: max 42 chars per line, max 2 lines per subtitle.
  
  // Simple strategy: Group words into blocks until gap > 1s OR max chars reached.
  
  let currentBlock: CaptionWord[] = [];
  let lastEnd = 0;
  
  for (const word of captions) {
    // If gap is too large, start new block
    if (currentBlock.length > 0 && word.startMs - lastEnd > 1000) {
       srt += formatSrtBlock(index++, currentBlock);
       currentBlock = [];
    }
    
    currentBlock.push(word);
    lastEnd = word.endMs;
    
    // Check length limit (rough heuristic: 80 chars)
    const textLen = currentBlock.reduce((acc, w) => acc + w.text.trim().length + 1, 0);
    if (textLen > 80) {
       srt += formatSrtBlock(index++, currentBlock);
       currentBlock = [];
    }
  }
  
  if (currentBlock.length > 0) {
    srt += formatSrtBlock(index++, currentBlock);
  }
  
  return srt;
}

function formatSrtBlock(index: number, words: CaptionWord[]): string {
  if (words.length === 0) return "";
  const start = msToSrtTimestamp(words[0].startMs);
  const end = msToSrtTimestamp(words[words.length - 1].endMs);
  const text = words.map(w => w.text.trim()).join(" ");
  return `${index}\n${start} --> ${end}\n${text}\n\n`;
}

// ... inside alignRoute function ...

  // 5f. Download captions as SRT
  app.get<{ Params: { projectId: string }; Reply: string | ErrorResponse }>(
    "/api/projects/:projectId/captions.srt",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (!session.captions) {
         // Fallback to transcript words if captions not set? 
         // But `captions` should be set by align/viral-clips steps.
         // If we are in REVIEW, captions exist.
         // If they don't, try correct transcript?
         if (session.transcript) {
            // Convert transcript words to captions format on the fly if needed
            session.captions = wordsToCaptions(session.transcript.words);
         } else {
            return reply.status(400).send({ success: false, error: "No captions available" });
         }
      }

      const srt = captionsToSrt(session.captions);

      return reply
        .header("Content-Type", "application/x-subrip")
        .header("Content-Disposition", 'attachment; filename="captions.srt"')
        .send(srt);
    }
  );

  // 5g. Upload reference script text
  app.post<{
    Params: { projectId: string };
    Body: { scriptText: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/script",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const { scriptText } = (request.body ?? {}) as Partial<{ scriptText: string }>;

      if (!scriptText || typeof scriptText !== "string") {
        return reply.status(400).send({ success: false, error: "scriptText is required" });
      }

      orchestrator.setScriptText(projectId, scriptText);
      return { success: true as const };
    }
  );

  // POST /api/projects/:projectId/run-gemini
  // Trigger Gemini automation on a session already in ALIGNING state
  app.post<{ Params: { projectId: string }; Reply: { success: true } | ErrorResponse }>(
    "/api/projects/:projectId/run-gemini",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      if (session.state !== "ALIGNING") {
        return reply.status(409).send({ success: false, error: `Cannot run Gemini in state: ${session.state}` });
      }
      if (!session.transcript) {
        return reply.status(409).send({ success: false, error: "No transcript available" });
      }

      // Reset progress so the UI shows the automation running
      orchestrator.updateProgress(projectId, 0, "Starting Gemini...");

      // Fire-and-forget — progress events update the client
      runGeminiAutomation(projectId, session.transcript, app.log).catch(() => {});

      return { success: true as const };
    }
  );
}
