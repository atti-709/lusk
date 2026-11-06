import { describe, it, expect } from "vitest";
import { applyProofreadEdits, buildProofreadLines } from "../services/proofread.js";
import { keepHeardDiacritics } from "../services/spokenForms.js";
import { restoreScriptDiacritics } from "../services/scriptForms.js";

const at = (words: string[]) => words.map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));
const texts = (ws: { word: string }[]) => ws.map((w) => w.word);

describe("keepHeardDiacritics (T27)", () => {
  // what the sk dictionary says about these (wordcheck.py, checked on the 27-sv-sample pairs)
  const REAL = new Set(["poznať", "keď", "kresťanstvom", "samota", "obraz", "skúseností", "skúsenosti", "evanjelia", "evanjeliá", "ovocie", "posolstvo", "a", "listov"]);
  const isWord = (w: string) => REAL.has(w.toLowerCase());
  const kept = (heard: string[], corrected: string[]) => texts(keepHeardDiacritics(at(heard), at(corrected), isWord));
  it("puts back a diacritic whose loss made a non-word (E52 poznat, E19 ked)", () => {
    expect(kept(["poznať"], ["poznat"])).toEqual(["poznať"]);
    expect(kept(["keď"], ["ked"])).toEqual(["keď"]);
  });
  it("keeps the corrected word's punctuation, quotes and case", () => {
    expect(kept(["poznať"], ["poznat,"])).toEqual(["poznať,"]);
    expect(kept(["poznať"], ["„Poznat“"])).toEqual(["„Poznať“"]);
  });
  it("handles several diacritics", () => {
    expect(kept(["kresťanstvom"], ["krestanstvom"])).toEqual(["kresťanstvom"]);
  });
  it("lets the correction drop a length mark Whisper added (samotá, obráz: the corrected word is real)", () => {
    expect(kept(["samotá"], ["samota"])).toEqual(["samota"]);
    expect(kept(["obráz"], ["obraz"])).toEqual(["obraz"]);
  });
  it("keeps the correction where both are real words", () => {
    expect(kept(["skúseností"], ["skúsenosti"])).toEqual(["skúsenosti"]);
  });
  it("leaves added or changed diacritics alone", () => {
    expect(kept(["evanjelia"], ["evanjeliá"])).toEqual(["evanjeliá"]);
    expect(kept(["poznať"], ["poznáť"])).toEqual(["poznáť"]);
    expect(kept(["poznat"], ["poznať"])).toEqual(["poznať"]);
  });
  it("leaves other words and retimed words alone", () => {
    expect(kept(["poznať"], ["ovocie"])).toEqual(["ovocie"]);
    expect(texts(keepHeardDiacritics(at(["poznať"]), [{ word: "poznat", startMs: 5, endMs: 9 }], isWord))).toEqual(["poznat"]);
  });
  it("does not disturb restoreScriptDiacritics (evanjeliá)", () => {
    const words = at(["posolstvo", "evanjelia", "a", "listov"]);
    const script = "posolstvo evanjeliá a listov. posolstvo evanjeliá a listov.";
    const kept2 = keepHeardDiacritics(words, words, isWord);
    expect(texts(restoreScriptDiacritics(kept2, script))).toEqual(["posolstvo", "evanjeliá", "a", "listov"]);
  });
});

describe("a find that omits the line's opening quote (T27, E52)", () => {
  const go = (line: string, find: string, replace: string) => {
    const w = at(line.split(" "));
    return applyProofreadEdits(w, buildProofreadLines(w), [{ line: 1, find, replace }]);
  };
  it("matches 'strom poznat' on „strom poznat podľa ovocia“ and keeps the quote", () => {
    const r = go("„strom poznat podľa ovocia“", "strom poznat", "strom poznať");
    expect(r.rejected).toHaveLength(0);
    expect(texts(r.words)).toEqual(["„strom", "poznať", "podľa", "ovocia“"]);
  });
  it("keeps the quote when the first word itself changes", () => {
    const r = go("„stom poznať podľa ovocia“", "stom", "strom");
    expect(r.rejected).toHaveLength(0);
    expect(r.words[0].word).toBe("„strom");
  });
  it("tolerates other leading marks", () => {
    const r = go("povedal (poznat) a «odišiel»", "poznat", "poznať");
    expect(texts(r.words)).toEqual(["povedal", "(poznať)", "a", "«odišiel»"]);
  });
});
