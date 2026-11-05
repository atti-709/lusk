import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "../../scripts");

/** Runs a snippet against transcribe.py's pure helpers (its imports of whisperx / mlx are lazy). */
function py(code: string): unknown {
  const prelude = "import sys, json; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); import transcribe as T\n";
  return JSON.parse(execFileSync("python3", ["-I", "-c", prelude + code, scripts], { encoding: "utf-8" }));
}

describe("transcribe.py per-language stock phrases and abbreviations", () => {
  it("keeps the Slovak stock phrases exactly", () => {
    expect((py("print(json.dumps(sorted(T.STOCK_PHRASES['sk'])))") as string[]).sort()).toEqual([
      "dakujem za pozornost", "dakujem za pozretie", "dakujem za sledovanie", "dakujeme za pozornost", "dakujeme za sledovanie",
      "thank you for watching", "thank you for your attention", "titulky vytvoril johnyx",
    ]);
  });

  it("keeps the Slovak abbreviations exactly", () => {
    expect((py("print(json.dumps(sorted(T.ABBREVIATIONS['sk'])))") as string[]).sort()).toEqual(
      ["atď", "dr", "kap", "kr", "mr", "napr", "porov", "pozn", "pr", "resp", "st", "str", "sv", "tj", "tzv", "vs", "č"],
    );
  });

  it("Czech has its own stock phrases, diacritics-stripped like the others", () => {
    expect(py("print(json.dumps([T.is_stock_phrase(t, 'cs') for t in ['Děkuji za pozornost.', 'Titulky vytvořil JohnyX', 'Konec.', 'Děkuji za pozornost. Děkuji za pozornost.', 'Konec světa.']]))"))
      .toEqual([true, true, true, true, false]);
  });

  it("Slovak does not drop Czech-only phrases, and the default language is Slovak", () => {
    expect(py("print(json.dumps([T.is_stock_phrase('Konec.'), T.is_stock_phrase('Děkuji za pozornost.', 'sk'), T.is_stock_phrase('Ďakujem za pozornosť.'), T.is_stock_phrase('Ďakujem za pozornosť.', 'sk')]))"))
      .toEqual([false, false, true, true]);
  });

  it("an unknown language uses the Slovak lists", () => {
    expect(py("print(json.dumps([T.is_stock_phrase('Ďakujem za pozornosť.', 'en'), T.is_stock_phrase('Konec.', 'en')]))")).toEqual([true, false]);
  });

  it("keeps the dot of a Czech abbreviation before a lower-case word, and drops a mid-sentence stop", () => {
    const code = `
segs = lambda a, b: [{"text": a}, {"text": b}]
out = {}
for abbr in ["např.", "tzv.", "atd.", "tzn.", "apod.", "resp.", "tj.", "sv.", "kap.", "př.", "mj."]:
    out[abbr] = T.join_sentences(segs("Řekl " + abbr, "něco dál"), "cs")[0]["text"]
out["stop"] = T.join_sentences(segs("Řekl to.", "něco dál"), "cs")[0]["text"]
print(json.dumps(out))`;
    const out = py(code) as Record<string, string>;
    for (const abbr of ["např.", "tzv.", "atd.", "tzn.", "apod.", "resp.", "tj.", "sv.", "kap.", "př.", "mj."]) expect(out[abbr]).toBe(`Řekl ${abbr}`);
    expect(out.stop).toBe("Řekl to");
  });

  it("Slovak join_sentences behaves as before (napr. keeps its dot; the Czech 'např.' is not special)", () => {
    const code = `
segs = lambda a, b: [{"text": a}, {"text": b}]
print(json.dumps([T.join_sentences(segs("Povedal napr.", "niečo"))[0]["text"], T.join_sentences(segs("Povedal např.", "niečo"))[0]["text"]]))`;
    expect(py(code)).toEqual(["Povedal napr.", "Povedal např"]);
  });
});

describe("transcribe.py model for a chunk in another language (T11)", () => {
  it("decodes Czech in a Slovak talk with the Czech fine-tune and Slovak in a Czech talk with the Slovak one", () => {
    expect(py("print(json.dumps([T.model_for_language('large-v3-turbo-sk', 'cs'), T.model_for_language('large-v3-cs', 'sk')]))"))
      .toEqual(["large-v3-cs", "large-v3-turbo-sk"]);
  });

  it("leaves every other language with the project model's base model", () => {
    expect(py("print(json.dumps([T.model_for_language('large-v3-turbo-sk', 'en'), T.model_for_language('large-v3-cs', 'en')]))"))
      .toEqual(["large-v3-turbo", "large-v3"]);
  });
});
