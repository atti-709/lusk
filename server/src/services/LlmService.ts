import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import {
  getLlama,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaContext,
} from "node-llama-cpp";
import type { TranscriptData, ViralClip } from "@lusk/shared";

const MODEL_FILENAME = "Meta-Llama-3-8B-Instruct.Q4_K_M.gguf";

type ProgressCallback = (percent: number, message: string) => void;

interface LlmClipResponse {
  clips: Array<{
    title: string;
    hookText: string;
    quoteStart: string;
    quoteEnd: string;
  }>;
}

class LlmService {
  private modelsDir: string;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;

  constructor(modelsDir?: string) {
    this.modelsDir =
      modelsDir ?? path.join(import.meta.dirname, "../../models");
  }

  private async ensureModel(): Promise<LlamaModel | null> {
    if (this.model) return this.model;

    const modelPath = path.join(this.modelsDir, MODEL_FILENAME);
    try {
      await access(modelPath);
    } catch {
      return null;
    }

    this.llama = await getLlama();
    this.model = await this.llama.loadModel({ modelPath });
    return this.model;
  }

  /**
   * Find the timestamp of a text quote within the transcript.
   * Uses normalized substring matching on joined transcript text.
   */
  private findTimestamp(
    words: TranscriptData["words"],
    quote: string,
    searchFromMs = 0
  ): number | null {
    const quoteNorm = quote.toLowerCase().trim();
    if (!quoteNorm) return null;

    const quoteWords = quoteNorm.split(/\s+/);
    if (quoteWords.length === 0) return null;

    // Sliding window match
    for (let i = 0; i < words.length; i++) {
      if (words[i].startMs < searchFromMs) continue;

      let matched = true;
      for (let k = 0; k < quoteWords.length && i + k < words.length; k++) {
        if (words[i + k].word.toLowerCase() !== quoteWords[k]) {
          matched = false;
          break;
        }
      }
      if (matched) return words[i].startMs;
    }

    // Fallback: partial match on first few words
    const firstWord = quoteWords[0];
    for (let i = 0; i < words.length; i++) {
      if (words[i].startMs < searchFromMs) continue;
      if (words[i].word.toLowerCase() === firstWord) return words[i].startMs;
    }

    return null;
  }

  async findViralClips(
    transcript: TranscriptData,
    sessionDir: string,
    onProgress?: ProgressCallback
  ): Promise<ViralClip[]> {
    onProgress?.(5, "Loading LLM...");

    const model = await this.ensureModel();

    if (!model) {
      onProgress?.(100, "LLM model not found — skipping clip detection");
      return [];
    }

    onProgress?.(20, "LLM loaded, analyzing transcript...");

    const context = await model.createContext({ contextSize: 4096 });
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });

    const prompt = `You are an expert at finding viral moments in podcast transcripts. Analyze this Slovak podcast transcript and find 3-5 segments that would make compelling viral short-form videos (30-60 seconds each).

Return ONLY valid JSON in the following format. Do not include any introductory text, markdown formatting (like \`\`\`json), or explanations.

{
  "clips": [
    {
      "title": "Short catchy title",
      "hookText": "The opening hook sentence",
      "quoteStart": "Exact first 3-5 words from transcript",
      "quoteEnd": "Exact last 3-5 words from transcript"
    }
  ]
}

Transcript:
${transcript.text}`;

    onProgress?.(30, "Finding viral hooks...");

    const response = await session.prompt(prompt);

    onProgress?.(80, "Processing LLM results...");

    // Parse JSON (or fallback to text)
    let parsedClips: LlmClipResponse["clips"] = [];
    
    // 1. Try JSON parsing
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        if (Array.isArray(json.clips)) {
          parsedClips = json.clips;
        }
      }
    } catch (e) {
      console.warn("JSON parsing failed, attempting fallback...", e);
    }

    // 2. Fallback: Regex parsing for text format
    // Matches format like: Title: "..." HookText: "..." QuoteStart: "..." QuoteEnd: "..."
    if (parsedClips.length === 0) {
      const clipBlocks = response.split(/\*\*Clip \d+:?\*\*/i).slice(1); // Skip preamble
      if (clipBlocks.length > 0) {
         for (const block of clipBlocks) {
           const title = block.match(/Title:\s*"(.*?)"/i)?.[1];
           const hookText = block.match(/HookText:\s*"(.*?)"/i)?.[1];
           const quoteStart = block.match(/QuoteStart:\s*"(.*?)"/i)?.[1];
           const quoteEnd = block.match(/QuoteEnd:\s*"(.*?)"/i)?.[1];

           if (title && hookText && quoteStart && quoteEnd) {
             parsedClips.push({ title, hookText, quoteStart, quoteEnd });
           }
         }
      }
      
      // If split failed, try global regex on the whole text
      if (parsedClips.length === 0) {
         const titles = [...response.matchAll(/Title:\s*"(.*?)"/gi)].map(m => m[1]);
         const hooks = [...response.matchAll(/HookText:\s*"(.*?)"/gi)].map(m => m[1]);
         const starts = [...response.matchAll(/QuoteStart:\s*"(.*?)"/gi)].map(m => m[1]);
         const ends = [...response.matchAll(/QuoteEnd:\s*"(.*?)"/gi)].map(m => m[1]);
         
         const count = Math.min(titles.length, hooks.length, starts.length, ends.length);
         for (let i = 0; i < count; i++) {
            parsedClips.push({
               title: titles[i],
               hookText: hooks[i],
               quoteStart: starts[i],
               quoteEnd: ends[i]
            });
         }
      }
    }

    if (parsedClips.length === 0) {
      // Save raw response for debugging
      await writeFile(
        path.join(sessionDir, "llm-raw-response.txt"),
        response
      );
      return [];
    }

    // Map quotes to timestamps
    const clips: ViralClip[] = [];
    for (const clip of parsedClips) {
      const startMs = this.findTimestamp(transcript.words, clip.quoteStart);
      const endMs = this.findTimestamp(
        transcript.words,
        clip.quoteEnd,
        startMs ?? 0
      );

      if (startMs !== null) {
        clips.push({
          title: clip.title,
          hookText: clip.hookText,
          startMs,
          endMs: endMs !== null ? endMs + 5000 : startMs + 45000,
        });
      }
    }

    onProgress?.(95, "Viral clips identified");

    // Save results for debugging
    await writeFile(
      path.join(sessionDir, "viral-clips.json"),
      JSON.stringify(clips, null, 2)
    );

    context.dispose();

    return clips;
  }

  async dispose(): Promise<void> {
    if (this.model) {
      this.model = null;
    }
    if (this.llama) {
      await this.llama.dispose();
      this.llama = null;
    }
  }
}

export const llmService = new LlmService();
export { LlmService };
