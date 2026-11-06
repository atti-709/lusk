import { describe, it, expect } from "vitest";
import type { TranscriptWord } from "@lusk/shared";
import { applyProofreadEdits, buildProofreadLines } from "../services/proofread.js";

/** Words 400 ms apart, each 300 ms long. */
function timed(text: string): TranscriptWord[] {
  return text.split(" ").map((word, i) => ({ word, startMs: i * 400, endMs: i * 400 + 300 }));
}

function apply(text: string, edits: { line: number; find: string; replace: string }[]) {
  const words = timed(text);
  return applyProofreadEdits(words, buildProofreadLines(words), edits);
}

describe("buildProofreadLines", () => {
  it("splits on sentence ends, quotes included", () => {
    const lines = buildProofreadLines(timed("Prvá veta. Druhá „citát.“ Tretia"));
    expect(lines.map((l) => l.words)).toEqual([[0, 1], [2, 3], [4]]);
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("breaks run-on text at 30 words", () => {
    const lines = buildProofreadLines(timed(Array.from({ length: 65 }, (_, i) => `w${i}`).join(" ")));
    expect(lines.map((l) => l.words.length)).toEqual([30, 30, 5]);
  });
});

describe("applyProofreadEdits", () => {
  it("replaces a misheard word in place, keeping its timing", () => {
    const r = apply("nedostatok vážnosti oči Bohu.", [{ line: 1, find: "oči", replace: "voči" }]);
    expect(r.words.map((w) => w.word).join(" ")).toBe("nedostatok vážnosti voči Bohu.");
    expect(r.words[2]).toEqual({ word: "voči", startMs: 800, endMs: 1100 });
    expect(r.applied).toHaveLength(1);
  });

  it("splits a run-together word inside the original word's slot", () => {
    const r = apply("sú vypočuté niekvôli chybe.", [{ line: 1, find: "niekvôli", replace: "nie kvôli" }]);
    expect(r.words.map((w) => w.word)).toEqual(["sú", "vypočuté", "nie", "kvôli", "chybe."]);
    expect(r.words[2].startMs).toBe(800);
    expect(r.words[3].endMs).toBe(1100);
    expect(r.words[4].startMs).toBe(1200); // untouched
  });

  it("times an inserted word from its neighbour, leaving the rest alone", () => {
    const r = apply("modliť slová je", [{ line: 1, find: "modliť slová", replace: "modliť sa slová" }]);
    expect(r.words.map((w) => w.word)).toEqual(["modliť", "sa", "slová", "je"]);
    expect(r.words[0].startMs).toBe(0);
    expect(r.words[1].startMs).toBeGreaterThan(0);
    expect(r.words[1].endMs).toBeLessThanOrEqual(300);
    expect(r.words[2]).toEqual({ word: "slová", startMs: 400, endMs: 700 });
  });

  it("deletes a hallucinated repeat", () => {
    const r = apply("je je to", [{ line: 1, find: "je je", replace: "je" }]);
    expect(r.words.map((w) => w.word)).toEqual(["je", "to"]);
    expect(r.words[1].startMs).toBe(800);
  });

  it("fixes punctuation attached to a word", () => {
    const r = apply("On vie, všetko, čo", [{ line: 1, find: "vie, všetko,", replace: "vie všetko," }]);
    expect(r.words.map((w) => w.word).join(" ")).toBe("On vie všetko, čo");
    expect(r.words[1].startMs).toBe(400);
    expect(r.words[2].startMs).toBe(800);
  });

  it("drops edits whose text isn't on the line", () => {
    const r = apply("Prvá veta. Druhá veta.", [
      { line: 1, find: "Druhá", replace: "druhá" }, // on line 2, not 1
      { line: 9, find: "veta.", replace: "veta!" }, // no such line
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    expect(r.words.map((w) => w.word).join(" ")).toBe("Prvá veta. Druhá veta.");
  });

  it("rejects rewrites", () => {
    const r = apply("Ja si určite myslím, že áno.", [
      { line: 1, find: "Ja si určite myslím,", replace: "Ty vôbec netušíš," },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
  });

  it("applies the same fix to the next occurrence, never twice to one word", () => {
    const r = apply("a oči a oči", [
      { line: 1, find: "oči", replace: "voči" },
      { line: 1, find: "oči", replace: "voči" },
    ]);
    expect(r.words.map((w) => w.word).join(" ")).toBe("a voči a voči");
  });
});

describe("applyProofreadEdits: omissions (T26)", () => {
  it("keeps a name's initials on one line, so 'S. Lewis' can become 'C. S. Lewis'", () => {
    const r = apply("hovorí S. Lewis, že to je. Potom", [{ line: 1, find: "S. Lewis,", replace: "C. S. Lewis," }]);
    expect(r.words.map((w) => w.word).slice(0, 5)).toEqual(["hovorí", "C.", "S.", "Lewis,", "že"]);
  });

  it("keeps a spoken word that only looks like a repeat (E64 14:15)", () => {
    const r = apply("milovať skutočných ľudí, nie ideálnych ľudí.", [
      { line: 1, find: "nie ideálnych ľudí.", replace: "nie ideálnych." },
    ]);
    expect(r.words.map((w) => w.word).join(" ")).toBe("milovať skutočných ľudí, nie ideálnych ľudí.");
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].why).toBe("not adjacent");
  });

  it("still drops a word that repeats its neighbour, before or after it", () => {
    expect(apply("to je je ono", [{ line: 1, find: "je je", replace: "je" }]).words.map((w) => w.word)).toEqual(["to", "je", "ono"]);
    expect(apply("to je je ono", [{ line: 1, find: "to je je", replace: "to je" }]).words.map((w) => w.word)).toEqual(["to", "je", "ono"]);
  });

  it("allows merging two words into one", () => {
    const r = apply("dal som to pre to", [{ line: 1, find: "pre to", replace: "preto" }]);
    expect(r.words.map((w) => w.word)).toEqual(["dal", "som", "to", "preto"]);
  });

  it("allows a misheard two-word name to become one word", () => {
    const r = apply("to je kasi Modlo. Potom", [{ line: 1, find: "kasi Modlo.", replace: "Quasimodo." }]);
    expect(r.words.map((w) => w.word)).toEqual(["to", "je", "Quasimodo.", "Potom"]);
  });

  it("allows a misheard name to become one word however far its spelling (E64 Notre-Dame)", () => {
    const r = apply("pri katedrále northern Dám, v Paríži", [{ line: 1, find: "northern Dám,", replace: "Notre-Dame," }]);
    expect(r.words.map((w) => w.word)).toEqual(["pri", "katedrále", "Notre-Dame,", "v", "Paríži"]);
  });

  it("rejects a deletion that also changes the case of the word it keeps", () => {
    const r = apply("C. S. Lewis vás povedal, že", [{ line: 1, find: "vás povedal,", replace: "Povedal," }]);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0].why).toBe("not adjacent");
  });

  it("rejects dropping an unrelated word", () => {
    const r = apply("to je ten Boh a on", [{ line: 1, find: "je ten Boh", replace: "je Boh" }]);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0].why).toBe("not adjacent");
  });

  it("names a find that straddles a joined token", () => {
    const words = [{ word: "hovorí", startMs: 0, endMs: 300 }, { word: "S. Lewis,", startMs: 400, endMs: 700 }, { word: "že", startMs: 800, endMs: 1100 }];
    const r = applyProofreadEdits(words, buildProofreadLines(words), [{ line: 1, find: "S. Lewis,", replace: "C. S. Lewis," }]);
    expect(r.rejected[0].why).toBe("joined token");
  });
});
