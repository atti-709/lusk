import { describe, it, expect } from "vitest";
import { keepSpokenForms } from "../services/spokenForms.js";

const at = (words: string[]) => words.map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));
const REAL = new Set(["neverím", "neveríme", "kameň", "kameňom", "nebol", "Vedieť", "Vedec", "ale", "alebo", "rôzni", "rôzny", "hľadajú", "hľadaj"]);
const real = (w: string) => REAL.has(w);
const texts = (ws: { word: string }[]) => ws.map((w) => w.word);

describe("keepSpokenForms", () => {
  it("puts back an ending the correction changed toward the script", () => {
    // E08: "ja neverím" → "neveríme", "nebol kameň" → "kameňom"
    const out = keepSpokenForms(at(["neverím", "nebol", "kameň."]), at(["neveríme", "nebol", "kameňom."]), real);
    expect(texts(out)).toEqual(["neverím", "nebol", "kameň."]);
  });
  it("keeps a correction of a word that isn't real", () => {
    const out = keepSpokenForms(at(["počatočné"]), at(["počiatočné"]), real);
    expect(texts(out)).toEqual(["počiatočné"]);
  });
  it("keeps spelling fixes, capitalised words and short words", () => {
    const heard = at(["rôzny", "Vedieť", "ale"]);
    const out = keepSpokenForms(heard, at(["rôzni", "Vedec", "alebo"]), real);
    expect(texts(out)).toEqual(["rôzni", "Vedec", "alebo"]);
  });
  it("leaves words the proofread retimed alone", () => {
    const heard = at(["neverím"]);
    const out = keepSpokenForms(heard, [{ word: "neveríme", startMs: 10, endMs: 250 }], real);
    expect(texts(out)).toEqual(["neveríme"]);
  });
});
