import { describe, it, expect } from "vitest";
import { parseTsv } from "../routes/align.js";

const BASE = [
  "00:00:01.000\tPrišiel",
  "00:00:01.400\tna",
  "00:00:01.900\tmiesto",
  "00:00:02.600\ta",
  "00:00:02.800\todišiel",
];
const FALLBACK_END = 3500;

const starts = (tsv: string[]) => parseTsv(tsv.join("\n"), FALLBACK_END).map((w) => w.startMs);
const wordsOf = (tsv: string[]) => parseTsv(tsv.join("\n"), FALLBACK_END).map((w) => w.word);

describe("parseTsv", () => {
  it("times timestamped rows from their own timestamp, ending at the next word", () => {
    const words = parseTsv(BASE.join("\n"), FALLBACK_END);
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
      [1000, 1400],
      [1400, 1900],
      [1900, 2600],
      [2600, 2800],
      [2800, 3500],
    ]);
  });

  it("keeps a source word's own end, so a pause stays a pause", () => {
    // "miesto" ends at 2100, then a pause until "a" at 2600
    const source = [[1000, 1300], [1400, 1800], [1900, 2100], [2600, 2750], [2800, 3200]].map(
      ([startMs, endMs], i) => ({ word: `w${i}`, startMs, endMs }),
    );
    const words = parseTsv(BASE.join("\n"), FALLBACK_END, source);
    expect(words.map((w) => w.endMs)).toEqual([1300, 1800, 2100, 2750, 3200]);
  });

  it("caps a source word's end at an inserted word, which fills the rest of the slot", () => {
    const source = [{ word: "Prišiel", startMs: 1000, endMs: 1900 }];
    const words = parseTsv(["00:00:01.000\tPrišiel", "\tsa", "00:00:02.000\ttam"].join("\n"), FALLBACK_END, source);
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([[1000, 1500], [1500, 2000], [2000, 3500]]);
  });

  describe("inserted words", () => {
    // A correction may add a word that was never transcribed as its own token
    const EXPECTED = ["Prišiel", "na", "to", "miesto", "a", "odišiel"];

    it("accepts a row with an empty timestamp column", () => {
      const tsv = [BASE[0], BASE[1], "\tto", ...BASE.slice(2)];
      expect(wordsOf(tsv)).toEqual(EXPECTED);
      expect(starts(tsv)).toEqual([1000, 1400, 1650, 1900, 2600, 2800]);
    });

    it("accepts a bare word with no tab at all", () => {
      const tsv = [BASE[0], BASE[1], "to", ...BASE.slice(2)];
      expect(wordsOf(tsv)).toEqual(EXPECTED);
      expect(starts(tsv)).toEqual([1000, 1400, 1650, 1900, 2600, 2800]);
    });

    it("accepts a row that repeats the previous timestamp", () => {
      const tsv = [BASE[0], BASE[1], "00:00:01.400\tto", ...BASE.slice(2)];
      expect(wordsOf(tsv)).toEqual(EXPECTED);
      expect(starts(tsv)).toEqual([1000, 1400, 1650, 1900, 2600, 2800]);
    });

    it("leaves every timestamped word's start untouched", () => {
      const tsv = [BASE[0], BASE[1], "\tto", ...BASE.slice(2)];
      const inserted = parseTsv(tsv.join("\n"), FALLBACK_END);
      expect(inserted.filter((w) => w.word !== "to").map((w) => w.startMs)).toEqual(starts(BASE));
    });

    it("splits the slot evenly across a run of inserted words", () => {
      const tsv = [BASE[0], BASE[1], "\tto", "\ttam", ...BASE.slice(2)];
      expect(starts(tsv)).toEqual([1000, 1400, 1567, 1733, 1900, 2600, 2800]);
    });

    it("borrows time before the first word and after the last", () => {
      const words = parseTsv(["\tNo", ...BASE, "\tvraj"].join("\n"), FALLBACK_END);
      expect(words[0]).toMatchObject({ word: "No", startMs: 880, endMs: 1000 });
      expect(words.at(-1)).toMatchObject({ word: "vraj", startMs: 3150, endMs: 3500 });
    });

    it("never produces a zero-length or backwards word", () => {
      const tsv = [BASE[0], "\ta", "\tb", "\tc", "\td", BASE[1], ...BASE.slice(2)];
      const words = parseTsv(tsv.join("\n"), FALLBACK_END);
      for (const [i, w] of words.entries()) {
        expect(w.endMs).toBeGreaterThan(w.startMs);
        if (i > 0) expect(w.startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
      }
    });
  });

  it("skips blank rows and rows carrying only a timestamp", () => {
    const tsv = [BASE[0], "", "00:00:01.500", "   ", BASE[1]];
    expect(wordsOf(tsv)).toEqual(["Prišiel", "na"]);
  });

  it("rejects a malformed timestamp rather than silently guessing", () => {
    expect(() => parseTsv("not-a-timestamp\tslovo", FALLBACK_END)).toThrow();
  });
});
