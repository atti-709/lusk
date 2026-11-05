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

describe("transcribe.py Czech stock phrases (T23)", () => {
  it("drops a segment that is only a lone Děkujeme., not one that thanks for something", () => {
    expect(py("print(json.dumps([T.is_stock_phrase(t, 'cs') for t in ['Děkujeme.', 'Konec.', 'Děkujeme za pozornost.', 'Děkujeme ti za to.', 'Děkuji.']]))"))
      .toEqual([true, true, true, false, false]);
    expect(py("print(json.dumps([T.is_stock_phrase(t, 'sk') for t in ['Ďakujeme.', 'Ďakujem za pozornosť.']]))")).toEqual([false, true]);
  });
});

describe("transcribe.py frees the resident MLX model (T22)", () => {
  // stand-ins for mlx.core and mlx_whisper's ModelHolder: the real ones need the Python env
  const fake = `
import types
cleared = []
mx = types.ModuleType('mlx.core'); mx.clear_cache = lambda: cleared.append(1)
holder = types.SimpleNamespace(model='weights', model_path='/m/large-v3')
tr = types.ModuleType('mlx_whisper.transcribe'); tr.ModelHolder = holder
for name, mod in [('mlx', types.ModuleType('mlx')), ('mlx.core', mx), ('mlx_whisper', types.ModuleType('mlx_whisper')), ('mlx_whisper.transcribe', tr)]:
    sys.modules[name] = mod
`;

  it("drops the holder's model and clears the cache", () => {
    expect(py(fake + "T.release_models(); print(json.dumps([holder.model, holder.model_path, len(cleared)]))")).toEqual([null, null, 1]);
  });

  it("keeps the model that is about to be used", () => {
    expect(py(fake + "T.release_models(keep='/m/large-v3'); print(json.dumps([holder.model, len(cleared)]))")).toEqual(["weights", 0]);
  });

  it("does nothing when nothing is resident", () => {
    expect(py(fake + "holder.model = None; T.release_models(); print(json.dumps(len(cleared)))")).toEqual(0);
  });
});

describe("transcribe.py spells numerals for forced alignment (T23)", () => {
  it("spells Slovak and Czech cardinals as one token and keeps punctuation", () => {
    expect(py("print(json.dumps([T.spell_number(n, 'sk') for n in [0, 4, 13, 22, 73, 77, 100, 142, 1000, 2025]]))")).toEqual([
      "nula", "štyri", "trinásť", "dvadsaťdva", "sedemdesiattri", "sedemdesiatsedem", "sto", "stoštyridsaťdva", "tisíc", "dvatisícdvadsaťpäť",
    ]);
    expect(py("print(json.dumps(T.spell_numerals('v Žalmoch 13, 42 a 4. Jn 3:16', 'cs')))")).toEqual(
      "v Žalmoch třináct, čtyřicetdva a čtyři. Jn tři:šestnáct",
    );
  });

  it("puts numerals back when whisperx has split the segment into sentences", () => {
    const code = `
segs = [{"text": "Mal 3,5 roka. Potom 13, 22 a 4"}]
spelled = [{"text": T.spell_numerals(segs[0]["text"], "sk")}]
aligned = [{"text": "Mal tri,päť roka.", "words": [{"word": "Mal"}, {"word": "tri,päť"}, {"word": "roka."}]},
           {"text": "Potom trinásť, dvadsaťdva a štyri", "words": [{"word": "Potom"}, {"word": "trinásť,"}, {"word": "dvadsaťdva"}, {"word": "a"}, {"word": "štyri"}]}]
T.restore_numerals(aligned, spelled, segs)
print(json.dumps([[w["word"] for s in aligned for w in s["words"]], [s["text"] for s in aligned]]))`;
    expect(py(code)).toEqual([
      ["Mal", "3,5", "roka.", "Potom", "13,", "22", "a", "4"],
      ["Mal 3,5 roka.", "Potom 13, 22 a 4"],
    ]);
  });

  it("a plain word equal to a spelled numeral keeps its place", () => {
    const code = `
segs = [{"text": "Ešte jeden verš, Žalm 1"}]
spelled = [{"text": T.spell_numerals(segs[0]["text"], "sk")}]
aligned = [{"text": spelled[0]["text"], "words": [{"word": w} for w in spelled[0]["text"].split()]}]
T.restore_numerals(aligned, spelled, segs)
print(json.dumps([w["word"] for w in aligned[0]["words"]]))`;
    expect(py(code)).toEqual(["Ešte", "jeden", "verš,", "Žalm", "1"]);
  });

  it("a segment whisperx could not align at all does not leave the later numerals spelled out", () => {
    const code = `
segs = [{"text": "Prvý verš je 3"}, {"text": "a toto je dlhý úsek bez zarovnania siedmich slov"}, {"text": "Žalm 22 a verš 4"}]
spelled = [{"text": T.spell_numerals(s["text"], "sk")} for s in segs]
aligned = [{"text": spelled[0]["text"], "words": [{"word": w} for w in spelled[0]["text"].split()]},
           {"text": spelled[1]["text"], "words": []},
           {"text": spelled[2]["text"], "words": [{"word": w} for w in spelled[2]["text"].split()]}]
T.restore_numerals(aligned, spelled, segs)
print(json.dumps([[w["word"] for w in s["words"]] for s in aligned]))`;
    expect(py(code)).toEqual([["Prvý", "verš", "je", "3"], [], ["Žalm", "22", "a", "verš", "4"]]);
  });

  it("each numeral stays one whitespace token; other languages and plain text are untouched", () => {
    expect(py("t = 'v Žalmoch 13, 22, 73, 10, 8, 77, 42 a 4, kde'; print(json.dumps([len(T.spell_numerals(t, 'sk').split()) == len(t.split()), T.spell_numerals(t, 'en') == t, T.spell_numerals('bez čísel', 'sk')]))"))
      .toEqual([true, true, "bez čísel"]);
  });
});
