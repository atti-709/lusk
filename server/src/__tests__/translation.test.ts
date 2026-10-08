import { describe, it, expect } from "vitest";
import { parseNumberedLines, translationChunks } from "../services/GeminiService.js";

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
