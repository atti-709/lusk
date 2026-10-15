import { describe, it, expect } from "vitest";
import { formatSrtBlocks, groupCaptionBlocks, wordsToCaptions } from "../routes/align.js";

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

  it("closes a cue before it could no longer be set as two lines of 42", () => {
    // E22 0:04: 84 characters whose only 42/42 splits end a line on "s" or "a" came out as one line
    const text = "že náš vesmír je jemne vyladený pre existenciu inteligentného života s presnosťou a zložitosťou";
    const words = text.split(" ").map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));
    const blocks = groupCaptionBlocks(wordsToCaptions(words), "sk").map((g) => ({
      text: g.map((w) => w.text.trim()).join(" "), startMs: g[0].startMs, endMs: g[g.length - 1].endMs,
    }));
    const srt = formatSrtBlocks(blocks, "sk");
    for (let i = 0; i < blocks.length; i++) {
      const lines = cue(srt, i);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    }
  });

  it("sets a translation too long for two lines of 42 on two balanced lines", () => {
    const text = "And this is exactly what the authors of the gospel wanted to show to the people of their own time";
    const lines = cue(formatSrtBlocks([{ text, startMs: 0, endMs: 5000 }], "en"));
    expect(lines).toHaveLength(2);
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThan(25);
  });

  it("never ends a cue on a one-letter word", () => {
    // E35 19:14: "…nás modlitebně nebo finančne podporiť. A" / "jelikož my chceme…"
    const text = "kdyby se spousta lidí nerozhodla nás modlitebně nebo finančně podpořit a jelikož my chceme v tomto projektu nadále pokračovat";
    const words = text.split(" ").map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));
    const groups = groupCaptionBlocks(wordsToCaptions(words), "sk");
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups.slice(0, -1)) expect(g[g.length - 1].text.trim()).not.toMatch(/^[aivkszuo]$/i);
  });
});
