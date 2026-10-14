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

describe("formatSrtBlocks layout", () => {
  const cue = (srt: string, i = 0) => srt.split("\r\n\r\n")[i].split("\r\n").slice(2);

  it("runs a cue on to the next one across a gap under half a second", () => {
    const srt = formatSrtBlocks([
      { text: "prvá", startMs: 1000, endMs: 3000 },
      { text: "druhá", startMs: 4100, endMs: 5000 },
    ], "sk");
    expect(times(srt)[0]).toEqual(["00:00:01,000", "00:00:04,020"]);
  });

  it("leaves a longer pause empty", () => {
    const srt = formatSrtBlocks([
      { text: "prvá", startMs: 1000, endMs: 3000 },
      { text: "druhá", startMs: 5000, endMs: 6000 },
    ], "sk");
    expect(times(srt)[0]).toEqual(["00:00:01,000", "00:00:03,700"]);
  });

  it("keeps a cue up at most 7 s unless the speech itself runs longer", () => {
    expect(times(formatSrtBlocks([{ text: "a b", startMs: 0, endMs: 6800 }], "sk"))[0]).toEqual(["00:00:00,000", "00:00:07,000"]);
    expect(times(formatSrtBlocks([{ text: "a b", startMs: 0, endMs: 7500 }], "sk"))[0]).toEqual(["00:00:00,000", "00:00:07,500"]);
  });

  it("never ends a line on a one-letter word", () => {
    const text = "Toto je dosť dlhá veta o tom, čo sa stalo v kostole na námestí.";
    const lines = cue(formatSrtBlocks([{ text, startMs: 0, endMs: 3000 }], "sk"));
    expect(lines).toHaveLength(2);
    for (const l of lines.slice(0, -1)) expect(l.split(" ").at(-1)).not.toMatch(/^[aivkszuo]$/i);
  });

  it("splits a long text top-heavy rather than leaving a line over 42 characters", () => {
    const text = "Medzinárodnoprávne záväzky Slovenskej republiky a krátke";
    const lines = cue(formatSrtBlocks([{ text, startMs: 0, endMs: 3000 }], "sk"));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
  });
});
