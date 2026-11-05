import { describe, it, expect } from "vitest";
import { restoreScriptDiacritics, scriptGlossary } from "../services/scriptForms.js";
import { applyProofreadEdits, buildProofreadLines } from "../services/proofread.js";
import { renderProofreadPrompt } from "../services/GeminiService.js";

const words = (text: string) => text.split(" ").map((word, i) => ({ word, startMs: i * 400, endMs: i * 400 + 350 }));
const text = (ws: { word: string }[]) => ws.map((w) => w.word).join(" ");

// E71: the script writes "evanjeliá" (nominative plural) 18 times and "evanjelia" (genitive singular) elsewhere
const E71_SCRIPT = [
  "Tieto argumenty dokazujú dve veci: po prvé, že evanjeliá boli napísané učeníkmi, nie neskoršími tvorcami mýtu.",
  "Prečo by mali byť za spisy, keď nie samotné evanjeliá a listy? Napokon, apoštoli boli svedkami.",
  "Július Müller hovorí o všetkých hlavných tvrdeniach evanjelia. Tento názor, že evanjeliá sú len mýtom, je slabý.",
  "Je to evanjelium podla Petra - vymysleny pribeh.",
].join("\n");

describe("restoreScriptDiacritics (E71 evanjelia)", () => {
  it("takes the script's form where the script writes it so around the same words", () => {
    const heard = words("Takže najprv dôkaz po druhé, že evanjelia boli napísané očitými svedkami");
    expect(text(restoreScriptDiacritics(heard, E71_SCRIPT))).toBe("Takže najprv dôkaz po druhé, že evanjeliá boli napísané očitými svedkami");
  });

  it("works from one neighbour when the other is not in the script, and keeps punctuation and capitals", () => {
    const heard = words("Evanjelia, ktoré máme. Potom spisy, keď nie samotné evanjelia a listy?");
    const out = text(restoreScriptDiacritics(heard, E71_SCRIPT));
    expect(out).toBe("Evanjelia, ktoré máme. Potom spisy, keď nie samotné evanjeliá a listy?");
  });

  it("leaves the genitive where the script writes the genitive", () => {
    const heard = words("so všetkými hlavnými tvrdeniami evanjelia. Július Müller hovorí");
    expect(text(restoreScriptDiacritics(heard, E71_SCRIPT))).toBe("so všetkými hlavnými tvrdeniami evanjelia. Július Müller hovorí");
  });

  it("never removes a diacritic because the script is written without them", () => {
    const heard = words("Je to evanjelium podľa Petra - vymyslený príbeh");
    expect(text(restoreScriptDiacritics(heard, E71_SCRIPT))).toBe("Je to evanjelium podľa Petra - vymyslený príbeh");
  });

  it("changes nothing when the script has the word in two forms in that context or none", () => {
    const script = "že evanjeliá boli napísané. Potom že evanjelia boli napísané.";
    const heard = words("že evanjelia boli napísané");
    expect(restoreScriptDiacritics(heard, script)).toEqual(heard);
    expect(restoreScriptDiacritics(heard, null)).toEqual(heard);
    expect(text(restoreScriptDiacritics(words("kde evanjelia nikdy"), script))).toBe("kde evanjelia nikdy");
  });

  it("keeps timings", () => {
    const heard = words("že evanjelia boli napísané");
    const out = restoreScriptDiacritics(heard, E71_SCRIPT);
    expect(out.map((w) => [w.startMs, w.endMs])).toEqual(heard.map((w) => [w.startMs, w.endMs]));
  });
});

describe("scriptGlossary (names for the proofread)", () => {
  const script = [
    "Ako by povedal Irenej z Lyonu: Gloria Dei homo vivens – Božia sláva je človek.",
    "Kazateľ Craig Groeschel hovorí, že Solženicyn to vedel. Potom prišiel Boh. Ježiš odpovedal.",
    "Craig Groeschel ďalej tvrdí svoje.",
  ].join("\n");

  it("lists capitalised runs, names with a connector whole, multi-word names first", () => {
    const g = scriptGlossary(script);
    expect(g).toContain("Irenej z Lyonu");
    expect(g).toContain("Craig Groeschel");
    expect(g).toContain("Solženicyn");
    expect(g.indexOf("Craig Groeschel")).toBeLessThan(g.indexOf("Solženicyn"));
    expect(g.filter((t) => t === "Craig Groeschel")).toHaveLength(1);
  });

  it("leaves out a lone sentence-opening word and names the transcript already has right", () => {
    expect(scriptGlossary(script)).not.toContain("Potom");
    expect(scriptGlossary(script)).not.toContain("Ako");
    const heard = ["Solženicyn", "Solženicyn", "a", "Solženicyn"];
    expect(scriptGlossary(script, [heard.join(" ")])).not.toContain("Solženicyn");
  });

  it("is capped", () => {
    const many = Array.from({ length: 500 }, (_, i) => `a Meno${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0) % 26)}${i}`).join(" ");
    expect(scriptGlossary(many).length).toBeLessThanOrEqual(200);
  });
});

describe("names the proofread proposes (E00 / E64 lines, punctuation attached)", () => {
  const edit = (ws: ReturnType<typeof words>, find: string, replace: string) => {
    const lines = buildProofreadLines(ws);
    return applyProofreadEdits(ws, lines, [{ line: 1, find, replace }]);
  };

  it("E00: 'A Crap Groeschel,' takes Craig Groeschel", () => {
    const r = edit(words("od ľudí alebo nemajú úplne porozumenie. A Crap Groeschel,".split(". ")[1]), "Crap Groeschel", "Craig Groeschel");
    expect(text(r.words)).toBe("A Craig Groeschel,");
  });

  it("E64: 'Irénysleonu: Gloria de jihomovivens,' takes the name and the Latin phrase", () => {
    const ws = words("ako by povedal Irénysleonu: Gloria de jihomovivens, božia sláva je ľudská");
    const lines = buildProofreadLines(ws);
    const r = applyProofreadEdits(ws, lines, [
      { line: 1, find: "Irénysleonu", replace: "Irenej z Lyonu" },
      { line: 1, find: "Gloria de jihomovivens", replace: "Gloria Dei homo vivens" },
    ]);
    expect(text(r.words)).toBe("ako by povedal Irenej z Lyonu: Gloria Dei homo vivens, božia sláva je ľudská");
    expect(r.rejected).toHaveLength(0);
  });
});

describe("the proofread prompt", () => {
  const template = "10. **Names** — {{NAMES_RULE}}\n{{SCRIPT_NOTE}}";
  it("sends the glossary hint with a script only", () => {
    expect(renderProofreadPrompt(template, "sk", "x")).toContain("listed after it");
    expect(renderProofreadPrompt(template, "sk", null)).not.toContain("listed after it");
  });
});
