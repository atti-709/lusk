import { describe, it, expect } from "vitest";
import { WhisperService } from "../services/WhisperService.js";

type W = { word: string; startMs: number | null; endMs: number | null };

// resolveMissingTimestamps is private; exercise it the way transcribe() does
const resolve = (untimed: W[]) =>
  (WhisperService.prototype as unknown as {
    resolveMissingTimestamps(u: W[]): { word: string; startMs: number; endMs: number }[];
  }).resolveMissingTimestamps.call(new WhisperService(), untimed);

const aligned = (word: string, startMs: number, endMs: number): W => ({ word, startMs, endMs });
const unaligned = (word: string): W => ({ word, startMs: null, endMs: null });

describe("resolveMissingTimestamps", () => {
  it("places an unalignable digit in the gap where it was spoken", () => {
    // WhisperX returns "10" with no start/end — the Slovak wav2vec2 vocab has no digits
    const words = resolve([
      aligned("náš", 5000, 5200),
      aligned("materiál", 5200, 5800),
      unaligned("10"),
      aligned("argumentov", 6300, 7000),
    ]);
    expect(words[2]).toEqual({ word: "10", startMs: 5800, endMs: 6300 });
  });

  it("leaves aligned words exactly as wav2vec2 timed them", () => {
    const input = [aligned("a", 100, 200), unaligned("10"), aligned("b", 900, 1000)];
    const words = resolve(input);
    expect(words[0]).toEqual({ word: "a", startMs: 100, endMs: 200 });
    expect(words[2]).toEqual({ word: "b", startMs: 900, endMs: 1000 });
  });

  it("splits the gap across a run of unalignable words", () => {
    const words = resolve([
      aligned("od", 0, 1000),
      unaligned("10"),
      unaligned("%"),
      aligned("po", 4000, 5000),
    ]);
    expect(words.slice(1, 3)).toEqual([
      { word: "10", startMs: 1000, endMs: 2500 },
      { word: "%", startMs: 2500, endMs: 4000 },
    ]);
  });

  it("handles an unalignable word at the very start and very end", () => {
    const words = resolve([unaligned("10"), aligned("eur", 1000, 1500), unaligned("50")]);
    expect(words[0]).toEqual({ word: "10", startMs: 700, endMs: 1000 });
    expect(words[2]).toEqual({ word: "50", startMs: 1500, endMs: 1800 });
  });

  it("never emits a zero-length or backwards word", () => {
    const words = resolve([
      aligned("a", 0, 1000),
      unaligned("10"),
      unaligned("20"),
      aligned("b", 1000, 1200), // degenerate: no gap at all
    ]);
    for (const [i, w] of words.entries()) {
      expect(w.endMs).toBeGreaterThan(w.startMs);
      if (i > 0) expect(w.startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
    }
  });

  it("times a transcript that is entirely unalignable", () => {
    const words = resolve([unaligned("10"), unaligned("20")]);
    expect(words).toEqual([
      { word: "10", startMs: 0, endMs: 300 },
      { word: "20", startMs: 300, endMs: 600 },
    ]);
  });
});
