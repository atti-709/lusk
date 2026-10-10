import { describe, it, expect } from "vitest";
import { GeminiService, hasForeignScript, parseNumberedLines, translationChunks } from "../services/GeminiService.js";

describe("translationChunks", () => {
  it("ends a chunk at the last sentence end before the limit", () => {
    const texts = Array.from({ length: 10 }, (_, i) => (i === 6 ? "koniec." : "slovo"));
    expect(translationChunks(texts, 8)).toEqual([{ start: 0, end: 7 }, { start: 7, end: 10 }]);
  });

  it("cuts at the limit when no sentence ends in the chunk's second half", () => {
    const texts = Array.from({ length: 10 }, (_, i) => (i === 1 ? "koniec." : "slovo"));
    expect(translationChunks(texts, 8)).toEqual([{ start: 0, end: 8 }, { start: 8, end: 10 }]);
  });

  it("counts a question or a closing quote as a sentence end", () => {
    expect(translationChunks(["a", "b", "c?", "d", "e"], 4)[0]).toEqual({ start: 0, end: 3 });
    expect(translationChunks(["a", "b", "c.“", "d", "e"], 4)[0]).toEqual({ start: 0, end: 3 });
  });

  it("covers every block exactly once", () => {
    const texts = Array.from({ length: 461 }, (_, i) => (i % 7 === 0 ? "veta." : "slovo"));
    const chunks = translationChunks(texts, 200);
    expect(chunks[0].start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(461);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  });
});

describe("parseNumberedLines", () => {
  it("places lines by their number, from the chunk's first number", () => {
    expect(parseNumberedLines("201. one\n202. two\n203. three", 201, 3)).toEqual(["one", "two", "three"]);
  });

  it("leaves a merged line empty instead of shifting the rest", () => {
    // Gemini joined 2 and 3 into one line: 3 is missing, 4 stays in place
    expect(parseNumberedLines("1. a\n2. b c\n4. d", 1, 4)).toEqual(["a", "b c", "", "d"]);
  });

  it("joins a wrapped line onto the one before", () => {
    expect(parseNumberedLines("1. who knows how\nto think\n\n2. never", 1, 2)).toEqual(["who knows how to think", "never"]);
  });

  it("ignores numbers outside the chunk", () => {
    expect(parseNumberedLines("0. x\n1. a\n2. b\n3. extra", 1, 2)).toEqual(["a", "b"]);
  });
});

describe("hasForeignScript", () => {
  it("flags a Cyrillic look-alike inside a Latin word", () => {
    expect(hasForeignScript("svetло")).toBe(true);
    expect(hasForeignScript("svetlo, čaká, Ďakujem")).toBe(false);
  });
});

describe("translateCaptions", () => {
  // Gemini stand-in: numbered "N. EN(text)" lines; a long request loses its third line by merging it
  // into the second, and the first answer to `cyrillicOnce` comes back in Cyrillic
  function fakeGemini(opts: { mergeAbove: number; cyrillicOnce?: string }) {
    let cyrillicSent = false;
    return {
      models: {
        generateContent: async ({ contents }: { contents: string }) => {
          const single = /Line to translate: (.*)/.exec(contents);
          if (single) return { text: `EN(${single[1]})` };
          const lines = [...contents.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), t: m[2] }));
          const out = lines.map(({ n, t }) => {
            if (opts.cyrillicOnce === t && !cyrillicSent) { cyrillicSent = true; return `${n}. свет`; }
            return `${n}. EN(${t})`;
          });
          if (lines.length > opts.mergeAbove) {
            out[1] = `${lines[1].n}. EN(${lines[1].t}) EN(${lines[2].t})`;
            out.splice(2, 1);
          }
          return { text: out.join("\n") };
        },
      },
    };
  }
  function service(ai: unknown) {
    const s = new GeminiService() as any;
    s.getClient = async () => ai;
    s.getCachedChunk = async () => null;
    s.setCachedChunk = async () => {};
    return s as GeminiService;
  }
  const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ text: i % 5 === 4 ? `veta${i}.` : `slovo${i}`, startMs: i, endMs: i + 1 }));

  it("returns one English line per block when Gemini merges lines in long requests", async () => {
    const out = await service(fakeGemini({ mergeAbove: 8 })).translateCaptions(blocks(40), "sk", "s", () => {});
    expect(out).toEqual(blocks(40).map((b) => `EN(${b.text})`));
  });

  it("translates line by line when even a short range keeps losing a line", async () => {
    const out = await service(fakeGemini({ mergeAbove: 0 })).translateCaptions(blocks(5), "sk", "s", () => {});
    expect(out).toEqual(blocks(5).map((b) => `EN(${b.text})`));
  });

  it("asks again when a line comes back in a foreign script", async () => {
    const out = await service(fakeGemini({ mergeAbove: 1000, cyrillicOnce: "slovo2" })).translateCaptions(blocks(6), "sk", "s", () => {});
    expect(out[2]).toBe("EN(slovo2)");
  });
});
