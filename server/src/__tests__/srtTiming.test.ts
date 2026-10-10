import { describe, it, expect } from "vitest";
import { formatSrtBlocks } from "../routes/align.js";

const times = (srt: string) => [...srt.matchAll(/(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})/g)].map((m) => [m[1], m[2]]);

describe("formatSrtBlocks", () => {
  it("holds a cue past its last word", () => {
    expect(times(formatSrtBlocks([{ text: "a b c", startMs: 1000, endMs: 3000 }], "sk"))).toEqual([["00:00:01,000", "00:00:03,700"]]);
  });

  it("never holds into the next cue", () => {
    const srt = formatSrtBlocks([
      { text: "prvá", startMs: 1000, endMs: 3000 },
      { text: "druhá", startMs: 3300, endMs: 5000 },
    ], "sk");
    expect(times(srt)[0]).toEqual(["00:00:01,000", "00:00:03,220"]);
  });

  it("keeps a short cue on screen for a second", () => {
    expect(times(formatSrtBlocks([{ text: "Áno.", startMs: 1000, endMs: 1200 }], "sk"))).toEqual([["00:00:01,000", "00:00:02,000"]]);
  });
});
