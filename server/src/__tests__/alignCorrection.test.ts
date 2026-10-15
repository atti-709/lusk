import { describe, it, expect } from "vitest";
import { alignCorrectedRows, dropStrayStops, keepHeardScript, misplacedBreaks } from "../services/alignCorrection.js";

const tsv = (words: string[]) => words.map((w, i) => `00:00:${String(i).padStart(2, "0")}.000\t${w}`);
const texts = (lines: string[]) => lines.map((l) => l.split("\t")[1]);

describe("alignCorrectedRows", () => {
  it("takes corrections row for row and keeps the input timestamps", () => {
    const out = alignCorrectedRows(tsv(["Dakujem", "za", "myšlenku"]), ["01:00.000\tĎakujem", "x\tza", "y\tmyšlienku."]);
    expect(out).toEqual(["00:00:00.000\tĎakujem", "00:00:01.000\tza", "00:00:02.000\tmyšlienku."]);
  });

  it("drops brackets Gemini puts round words that were heard plainly", () => {
    // E45 9:46: a quotation came back as "[nám] [vložil] [večnosť]" and the translation copied it
    const out = alignCorrectedRows(tsv(["Boh", "nám", "vložil", "väčnosť", "[smiech]"]), tsv(["Boh", "[nám]", "[vložil]", "[večnosť]", "[smiech]"]));
    expect(texts(out)).toEqual(["Boh", "nám", "vložil", "večnosť", "[smiech]"]);
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

describe("misplacedBreaks", () => {
  const rows = (words: string) => words.split(" ").map((w, i) => `00:00:${String(i).padStart(2, "0")}.000\t${w}`);

  it("counts full stops moved onto the word before (E06 7:10)", () => {
    expect(misplacedBreaks(rows("by to malo byť, že každý je zodpovedný."))).toBe(0);
    expect(misplacedBreaks(rows("by to malo byť. že každý je zodpovedný."))).toBe(1);
    expect(misplacedBreaks(rows("Existuje. prvá príčina. alebo nie"))).toBe(2);
  });

  it("ignores ordinals, abbreviations and real sentence ends", () => {
    expect(misplacedBreaks(rows("v 20. storočí napr. keď Koniec. Ďalší"))).toBe(0);
  });
});

describe("keepHeardScript", () => {
  it("keeps the heard word where the correction wrote a foreign script", () => {
    const heard = ["00:00:01.000\tsvetlo.", "00:00:02.000\tAkoby"];
    const corrected = ["00:00:01.000\tsvetло.", "00:00:02.000\tAkoby"];
    expect(keepHeardScript(heard, corrected, (t) => /[Ѐ-ӿ]/.test(t))).toEqual(heard);
  });
});

describe("dropStrayStops", () => {
  const text = (s: string) => dropStrayStops(s.split(" ").map((word) => ({ word, startMs: 0, endMs: 0 }))).map((w) => w.word).join(" ");

  it("drops a full stop the sentence carries on after (E35)", () => {
    expect(text("Tizian je však. už iný. Je ubitý")).toBe("Tizian je však už iný. Je ubitý");
    expect(text("im. dáva mená „Dismas.“ a potom")).toBe("im dáva mená „Dismas“ a potom");
  });

  it("keeps ordinals, abbreviations, ellipses, questions and real sentence ends", () => {
    for (const s of ["pápeža Pavla III. už v 20. storočí", "napr. keď", "To je... no", "Dobre? ale", "Koniec. Ďalší", "koniec."]) {
      expect(text(s)).toBe(s);
    }
  });
});
