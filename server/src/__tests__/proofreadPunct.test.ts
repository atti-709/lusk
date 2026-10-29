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

  it("moves the line's comma to the new last word on an insertion", () => {
    const { text } = run("Nebojte, lebo som s vami.", [{ find: "Nebojte", replace: "Nebojte sa" }]);
    expect(text).toBe("Nebojte sa, lebo som s vami.");
  });

  it("rejects a deletion that would take the sentence end and a no-op", () => {
    const a = run("Šli sme domov. Potom spal.", [{ find: "domov", replace: "" }]);
    expect(a.r.rejected).toHaveLength(1);
    const b = run("Šli sme domov. Potom spal.", [{ find: "domov,", replace: "domov" }]);
    expect(b.r.rejected).toHaveLength(1);
  });

  it("does not duplicate the comma when an insertion carries its own punctuation", () => {
    const { text } = run("Nebojte, lebo som s vami.", [{ find: "Nebojte", replace: "Nebojte sa," }]);
    expect(text).toBe("Nebojte sa, lebo som s vami.");
  });

  it("drops a repeat without leaving the kept word's comma behind", () => {
    expect(run("Vidím, že to, to je ono.", [{ find: "to to je", replace: "to je" }]).text).toBe("Vidím, že to je ono.");
    expect(run("A, a potom spal.", [{ find: "A a", replace: "A" }]).text).toBe("A potom spal.");
  });

  it("keeps an inner comma on a word that changed in place", () => {
    const { text } = run("Povedal Alexo, Konor a odišiel.", [{ find: "Alexo Konor", replace: "Alex Konor" }]);
    expect(text).toBe("Povedal Alex, Konor a odišiel.");
  });

  it("rejects an ambiguous loose match but takes a verbatim one", () => {
    const line = "Šli sme domov, a potom domov, spať.";
    expect(run(line, [{ find: "domov", replace: "doma" }]).r.rejected).toHaveLength(1);
    expect(run("Šli sme domov a potom domov, spať.", [{ find: "domov", replace: "doma" }]).text).toBe("Šli sme doma a potom domov, spať.");
  });
});
