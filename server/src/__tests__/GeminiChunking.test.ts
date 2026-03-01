import { describe, it, expect } from "vitest";
import { buildSlidingWindowChunks } from "../services/GeminiService.js";

describe("buildSlidingWindowChunks", () => {
  const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line${i}`);

  it("returns a single chunk when lines fit within CHUNK_SIZE", () => {
    const lines = makeLines(200);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 200, isFirst: true });
  });

  it("returns exactly one chunk when lines equal CHUNK_SIZE", () => {
    const lines = makeLines(500);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
  });

  it("produces overlapping windows for 950 lines", () => {
    const lines = makeLines(950);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
    expect(chunks[1]).toEqual({ startIndex: 450, endIndex: 950, isFirst: false });
  });

  it("produces correct windows for 1400 lines", () => {
    const lines = makeLines(1400);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
    expect(chunks[1]).toEqual({ startIndex: 450, endIndex: 950, isFirst: false });
    expect(chunks[2]).toEqual({ startIndex: 900, endIndex: 1400, isFirst: false });
  });

  it("merges a tiny tail into the previous chunk", () => {
    const lines = makeLines(520);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 520, isFirst: true });
  });

  it("does NOT merge when tail has enough new lines", () => {
    const lines = makeLines(600);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
    expect(chunks[1]).toEqual({ startIndex: 450, endIndex: 600, isFirst: false });
  });
});
