import { describe, it, expect } from "vitest";
import { alignCorrectedRows } from "../services/alignCorrection.js";

const tsv = (words: string[]) => words.map((w, i) => `00:00:${String(i).padStart(2, "0")}.000\t${w}`);
const texts = (lines: string[]) => lines.map((l) => l.split("\t")[1]);

describe("alignCorrectedRows", () => {
  it("takes corrections row for row and keeps the input timestamps", () => {
    const out = alignCorrectedRows(tsv(["Dakujem", "za", "myšlenku"]), ["01:00.000\tĎakujem", "x\tza", "y\tmyšlienku."]);
    expect(out).toEqual(["00:00:00.000\tĎakujem", "00:00:01.000\tza", "00:00:02.000\tmyšlienku."]);
  });

  it("does not shift rows between a script word inserted and another dropped", () => {
    // Same row count, but "božiu" was inserted and "dnes" dropped: by index every row
    // between them would take its neighbour's word.
    const heard = ["pre", "existenciu", "záverom", "bude", "ateizmus.", "A", "dnes", "o", "nej"];
    const gemini = ["pre", "božiu", "existenciu,", "záverom", "bude", "ateizmus.", "A", "o", "nej"];
    expect(texts(alignCorrectedRows(tsv(heard), tsv(gemini)))).toEqual(
      ["pre", "existenciu,", "záverom", "bude", "ateizmus.", "A", "dnes", "o", "nej"],
    );
  });

  it("keeps a spoken word the script would replace with a different one", () => {
    const out = alignCorrectedRows(tsv(["Citát", "od", "filozofa", "ak", "nebol"]), tsv(["Napísal", "od", "historik", "keď", "neexistoval?"]));
    expect(texts(out)).toEqual(["Citát", "od", "filozofa", "ak", "nebol?"]);
  });

  it("joins a row Gemini split in two", () => {
    const out = alignCorrectedRows(tsv(["vzniku", "planetizem.", "Beznádej", "je"]), tsv(["vznik", "planéty", "Zem.", "Bez", "nádeje", "je"]));
    expect(texts(out)).toEqual(["vznik", "planéty Zem.", "Bez nádeje", "je"]);
  });

  it("accepts preposition spellings and one-letter swaps but not a different short word", () => {
    const out = alignCorrectedRows(tsv(["z", "nim", "my", "sám", "sa"]), tsv(["s", "ním", "mi", "sa", "sám"]));
    expect(texts(out)).toEqual(["s", "ním", "mi", "sám", "sa"]);
  });

  it("keeps heard words Gemini dropped and handles a short output", () => {
    const out = alignCorrectedRows(tsv(["a", "potom", "prišiel", "domov"]), tsv(["potom", "prišiel"]));
    expect(texts(out)).toEqual(["a", "potom", "prišiel", "domov"]);
  });
});
