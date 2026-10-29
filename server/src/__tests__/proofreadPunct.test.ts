import { describe, it, expect } from "vitest";
import { applyProofreadEdits, buildProofreadLines } from "../services/proofread.js";

function run(text: string, edits: { find: string; replace: string }[]) {
  const words = text.split(" ").map((word, i) => ({ word, startMs: i * 400, endMs: i * 400 + 300 }));
  const lines = buildProofreadLines(words);
  const r = applyProofreadEdits(words, lines, edits.map((e) => ({ line: 1, ...e })));
  return { text: r.words.map((w) => w.word).join(" "), r };
}

describe("proofread punctuation-tolerant find", () => {
  it("matches a find missing the trailing comma and keeps the comma", () => {
    const { text, r } = run("Šli sme do zhromáždění, a potom domov.", [{ find: "do zhromáždění", replace: "do shromáždění" }]);
    expect(r.rejected).toHaveLength(0);
    expect(text).toBe("Šli sme do shromáždění, a potom domov.");
  });

  it("matches a find that leaves out a full stop inside a word", () => {
    const { text, r } = run("Čítal som J.R.Tolkiena, potom spal.", [{ find: "JRTolkiena", replace: "Tolkiena" }]);
    expect(r.rejected).toHaveLength(0);
    expect(text).toBe("Čítal som Tolkiena, potom spal.");
  });

  it("keeps the line's own punctuation on words the edit leaves unchanged", () => {
    const { text } = run("Boli sme tam, pri Dr.Novakovi a dosť.", [{ find: "tam pri Dr.Novakovi", replace: "tam pri Dr.Novákovi" }]);
    expect(text).toBe("Boli sme tam, pri Dr.Novákovi a dosť.");
  });

  it("uses the punctuation replace carries", () => {
    const { text } = run("Povedal Alexo Konor, a odišiel.", [{ find: "Alexo Konor", replace: "Alex O'Connor." }]);
    expect(text).toBe("Povedal Alex O'Connor. a odišiel.");
  });

  it("still drops a comma when find quoted it and replace has none", () => {
    const { text } = run("Vidím všetko, čo chcem.", [{ find: "všetko,", replace: "všetko" }]);
    expect(text).toBe("Vidím všetko čo chcem.");
  });

  it("stays strict: words that differ, or a rewrite, are still rejected", () => {
    const a = run("Šli sme do zhromáždění, a potom.", [{ find: "do zhromaždění", replace: "do shromáždění" }]);
    expect(a.r.rejected).toHaveLength(1);
    const b = run("Šli sme do zhromáždění, a potom.", [{ find: "sme do zhromáždění", replace: "úplne iná veta tu" }]);
    expect(b.r.rejected).toHaveLength(1);
  });
});
