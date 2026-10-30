import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The arbiter's service half: Gemini stubbed, a real settings/temp dir
const root = mkdtempSync(join(tmpdir(), "lusk-arbiter-"));
process.env.LUSK_REGISTRY_DIR = join(root, "registry");
process.env.LUSK_TEMP_DIR = join(root, "temp");
process.env.GEMINI_API_KEY = "test-key";

const generate = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generate };
  },
  ThinkingLevel: {},
}));

const {
  BATCH_SIZE, applyVerdicts, diffWords, findSpans, ftIsSideA, mergedSpans, normalizeWord, skipReason, summarize, verdictFor,
} = await import("../services/arbiter.js");
const { geminiService, isFatalGeminiError } = await import("../services/GeminiService.js");
const { sliceWav } = await import("../services/wavSlice.js");

type Seg = import("../services/arbiter.js").DecodedSegment;
const seg = (text: string, start = 0, end = 10, chunk: [number, number] = [0, 30]): Seg => ({ start, end, text, language: "sk", chunk });

describe("word diff and span merging", () => {
  it("normalises like the listening judge: case and punctuation out, diacritics kept", () => {
    expect(normalizeWord("Kresťania,")).toBe("kresťania");
    expect(normalizeWord("kresťania")).not.toBe(normalizeWord("krestania"));
  });

  it("merges differences within 3 words and keeps those further apart separate", () => {
    const a = "a b c d e f g h i j k l m".split(" ");
    const near = "a X c d e Y g h i j k l m".split(" "); // b and f differ, 3 equal words between: one span
    expect(mergedSpans(a, near, 3)).toHaveLength(1);
    const far = "a X c d e f g h i Y k l m".split(" "); // 6 equal words between: two spans
    expect(mergedSpans(a, far, 3)).toHaveLength(2);
    expect(mergedSpans(a, a)).toHaveLength(0);
  });

  it("diffs an insertion and a deletion", () => {
    expect(diffWords(["a", "b"], ["a", "x", "b"]).map((o) => o.tag)).toEqual(["equal", "insert", "equal"]);
    expect(diffWords(["a", "x", "b"], ["a", "b"]).map((o) => o.tag)).toEqual(["equal", "delete", "equal"]);
  });
});

describe("findSpans", () => {
  const ft = [seg("Dnes sme počuli o Dokins a jeho knihe, ktorú napísal pred mnohými rokmi pre všetkých ľudí.")];
  const base = [seg("Dnes sme počuli o Dawkins a jeho knihe, ktorú napísal pred mnohými rokmi pre všetkých ľudí.")];

  it("finds the differing word with ±6 words of context from each side's own text", () => {
    const { spans } = findSpans(ft, base);
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s.ft).toBe("Dokins");
    expect(s.base).toBe("Dawkins");
    expect(s.ftContext).toBe("Dnes sme počuli o Dokins a jeho knihe, ktorú napísal pred");
    expect(s.baseContext).toBe("Dnes sme počuli o Dawkins a jeho knihe, ktorú napísal pred");
    expect(s.skipped).toBeUndefined();
    expect(s.t1).toBeGreaterThan(s.t0);
  });

  it("compares only inside the same chunk, and leaves a chunk the base model has no decode for alone", () => {
    const other = [seg("Dnes sme počuli o Dawkins a jeho knihe", 0, 10, [100, 130])];
    const r = findSpans(ft, other);
    expect(r.spans).toHaveLength(0);
    expect(r.chunksCompared).toBe(0);
  });

  it("does not send what the owner ruled a non-defect: repeats, fillers, sentence-initial A/No/Tak, digits for words", () => {
    const f = [seg("Povedal že tú energiu mám raz dva tri štyri päť a No ale dobre raz dva tri štyri päť mám deväť rokov raz dva tri štyri päť a zároveň aj viac vecí.")];
    const b = [seg("Povedal že tú tú energiu mám raz dva tri štyri päť a ale dobre raz dva tri štyri päť mám 9 rokov raz dva tri štyri päť a zároveň ehm aj viac vecí.")];
    const spans = findSpans(f, b).spans;
    expect(spans.map((s) => s.skipped)).toEqual(["repeat", "filler", "number", "filler"]);
  });

  it("skips a base spelling that only lacks the fine-tune's diacritics", () => {
    const f = [seg("Tak kresťania veria tomu.")];
    const b = [seg("Tak krestania veria tomu.")];
    expect(findSpans(f, b).spans[0].skipped).toBe("formOnly");
  });

  it("skips a span across two segments and a rewrite of more than 25 words", () => {
    const f = [seg("jedna dva tri štyri päť", 0, 5), seg("šesť sedem osem deväť desať", 5, 10)];
    const b = [seg("jedna dva tri xx yy", 0, 5), seg("zz sedem osem deväť desať", 5, 10)];
    expect(findSpans(f, b).spans[0].skipped).toBe("crossSegment");
    expect(skipReason(Array(26).fill("x"), ["y"], [], [], [], [])).toBe("tooLong");
  });

  it("an insertion sits after the word before it", () => {
    const f = [seg("Poznáme tohto človeka veľmi dobre všetci spolu dnes večer tu.")];
    const b = [seg("Poznáme tohto človeka veľmi dobre Boh všetci spolu dnes večer tu.")];
    const s = findSpans(f, b).spans[0];
    expect(s.ft).toBe("");
    expect(s.base).toBe("Boh");
    expect([s.from, s.to]).toEqual([5, 5]);
  });
});

describe("sides and verdicts", () => {
  it("shuffles the sides: a fixed function of the span, about half of them each way", () => {
    const spans = Array.from({ length: 200 }, (_, i) => ({ id: `0-30:${i}`, ftContext: `a${i}`, baseContext: `b${i}` }));
    const flips = spans.map((s) => ftIsSideA(s, "p1"));
    expect(flips).toEqual(spans.map((s) => ftIsSideA(s, "p1")));
    const a = flips.filter(Boolean).length;
    expect(a).toBeGreaterThan(70);
    expect(a).toBeLessThan(130);
  });

  it("maps the letter back to a side; neither, same and no answer are never the base model", () => {
    expect(verdictFor("A", true)).toBe("ft");
    expect(verdictFor("A", false)).toBe("base");
    expect(verdictFor("B", true)).toBe("base");
    expect(verdictFor("B", false)).toBe("ft");
    for (const v of ["neither", "same", undefined, "C", "A or B"]) {
      expect(verdictFor(v, true)).not.toBe("base");
      expect(verdictFor(v, false)).not.toBe("base");
    }
  });
});

describe("applyVerdicts", () => {
  const ft = [seg("Čítali sme od Dokins a jeho knihe.", 0, 5), seg("Potom sme išli domov.", 5, 8)];
  const base = [seg("Čítali sme od Dawkins a jeho knihe. Potom sme išli domov.", 0, 8)];

  it("replaces the span only when the judge chose the base model, keeping the fine-tune's punctuation", () => {
    const { spans } = findSpans(ft, base);
    expect(spans).toHaveLength(1);
    spans[0].verdict = "base";
    spans[0].judged = true;
    const out = applyVerdicts(ft, spans);
    expect(out[0].text).toBe("Čítali sme od Dawkins a jeho knihe.");
    expect(out[1].text).toBe(ft[1].text);
    expect(out[0].start).toBe(0);
    for (const v of ["ft", "same", "neither", "none"] as const) {
      spans[0].verdict = v;
      expect(applyVerdicts(ft, spans)[0].text).toBe(ft[0].text);
    }
  });

  it("never applies a skipped span even if it carries a base verdict", () => {
    const { spans } = findSpans(ft, base);
    spans[0].skipped = "repeat";
    spans[0].verdict = "base";
    expect(applyVerdicts(ft, spans)[0].text).toBe(ft[0].text);
  });

  it("applies an insertion and a deletion", () => {
    const f = [seg("Poznáme tohto človeka veľmi dobre všetci spolu dnes večer tu a potom pôjdeme domov, ale hneď.")];
    const b = [seg("Poznáme tohto človeka veľmi dobre Boh všetci spolu dnes večer tu a potom pôjdeme.", 0, 10)];
    const spans = findSpans(f, b).spans;
    spans.forEach((s) => { s.verdict = "base"; s.judged = true; });
    const out = applyVerdicts(f, spans)[0].text;
    expect(out).toContain("dobre Boh všetci");
    expect(out.endsWith("pôjdeme.")).toBe(true); // the deleted tail's full stop moves to the word before
  });

  it("summarises what was sent and chosen", () => {
    const { spans } = findSpans(ft, base);
    spans[0].judged = true;
    spans[0].verdict = "neither";
    const s = summarize(spans, { batches: 1, calls: 1, cacheHits: 0 });
    expect(s.judged).toBe(1);
    expect(s.chose.neither).toBe(1);
    expect(s.chose.base).toBe(0);
  });
});

describe("GeminiService.arbitrateSpans", () => {
  const wavPath = join(root, "a.wav");
  beforeEach(() => {
    generate.mockReset();
    // 100 s of silence, 16 kHz mono s16, with the 44-byte header
    const pcm = Buffer.alloc(100 * 16000 * 2);
    writeFileSync(wavPath, Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\0\0\0\0", "latin1"), pcm]));
  });

  const mkSpans = (n: number) =>
    Array.from({ length: n }, (_, i): import("../services/arbiter.js").ArbiterSpan => ({
      id: `0-30:${i}`, chunk: "0-30", segment: 0, from: i, to: i + 1, ft: `f${i}`, base: `b${i}`,
      ftContext: `ctx f${i}`, baseContext: `ctx b${i}`, t0: i, t1: i + 3,
    }));

  /** Answers every item "A" */
  const answerA = (n: number) => ({ text: JSON.stringify({ results: Array.from({ length: n }, (_, id) => ({ id, verdict: "A", said: "x" })) }) });

  it("asks in batches of 15 with the audio of every span, and maps the letters back by the shuffled sides", async () => {
    generate.mockImplementation(async ({ contents }: any) => answerA(contents[0].parts.filter((p: any) => p.inlineData).length));
    const spans = mkSpans(40);
    const stats = await geminiService.arbitrateSpans(spans, { wavPath, language: "sk", sessionId: "sess-a" });
    expect(BATCH_SIZE).toBe(15);
    expect(stats).toMatchObject({ batches: 3, calls: 3, cacheHits: 0 });
    const sizes = generate.mock.calls.map(([r]) => r.contents[0].parts.filter((p: any) => p.inlineData).length).sort((a: number, b: number) => b - a);
    expect(sizes).toEqual([15, 15, 10]);
    for (const s of spans) expect(s.verdict).toBe(s.ftIsA ? "ft" : "base");
    expect(spans.every((s) => s.judged)).toBe(true);
    // the prompt carries no side marker beyond A / B, and no third answer is possible
    const req = generate.mock.calls[0][0];
    expect(req.config.responseJsonSchema.properties.results.items.properties.verdict.enum).toEqual(["A", "B", "same", "neither"]);
  });

  it("answers from the cache the second time", async () => {
    generate.mockImplementation(async ({ contents }: any) => answerA(contents[0].parts.filter((p: any) => p.inlineData).length));
    await geminiService.arbitrateSpans(mkSpans(20), { wavPath, language: "sk", sessionId: "sess-cache" });
    const first = generate.mock.calls.length;
    const spans = mkSpans(20);
    const stats = await geminiService.arbitrateSpans(spans, { wavPath, language: "sk", sessionId: "sess-cache" });
    expect(generate.mock.calls.length).toBe(first);
    expect(stats.cacheHits).toBe(2);
    expect(spans.every((s) => s.judged)).toBe(true);
  });

  it("an item the answer leaves out has no verdict and the fine-tune keeps its words", async () => {
    generate.mockResolvedValue({ text: JSON.stringify({ results: [{ id: 0, verdict: "B", said: "" }] }) });
    const spans = mkSpans(3);
    await geminiService.arbitrateSpans(spans, { wavPath, language: "sk", sessionId: "sess-miss" });
    expect(spans[1].verdict).toBe("none");
    expect(spans[2].verdict).toBe("none");
    expect(applyVerdicts([seg("f0 f1 f2")], spans.map((s) => ({ ...s, segment: 0 }))).at(0)!.text).not.toContain("b1");
  });

  it("retries a transient error with backoff and gives up on an unfixable one (402) by throwing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] }); // the file reads are real
    generate
      .mockRejectedValueOnce(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'))
      .mockImplementationOnce(async ({ contents }: any) => answerA(contents[0].parts.filter((p: any) => p.inlineData).length));
    const p = geminiService.arbitrateSpans(mkSpans(2), { wavPath, language: "sk", sessionId: "sess-retry" });
    for (let i = 0; i < 20; i++) { // the backoff timer is set after a real file read: keep advancing
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((r) => setImmediate(r));
    }
    const stats = await p;
    expect(stats.calls).toBe(2);
    vi.useRealTimers();

    generate.mockReset();
    generate.mockRejectedValue(new Error("402 prepayment credits are depleted"));
    await expect(geminiService.arbitrateSpans(mkSpans(2), { wavPath, language: "sk", sessionId: "sess-402" })).rejects.toThrow(/402/);
    expect(isFatalGeminiError(new Error("402"))).toBe(true);
    expect(isFatalGeminiError(new Error("503 UNAVAILABLE"))).toBe(false);
  });

  it("stops on the abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(geminiService.arbitrateSpans(mkSpans(2), { wavPath, language: "sk", sessionId: "sess-abort", signal: controller.signal })).rejects.toThrow(/Cancelled/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("sliceWav", () => {
  it("cuts a WAV of the asked length, finding the data chunk after a LIST chunk", async () => {
    const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
    const pcm = Buffer.alloc(16000 * 2 * 10);
    const header = Buffer.from("RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0", "latin1");
    const file = join(root, "list.wav");
    writeFileSync(file, Buffer.concat([header, list, Buffer.from("data"), Buffer.from([0, 0, 0, 0]), pcm]));
    const out = await sliceWav(file, 2, 5);
    expect(out.length).toBe(44 + 3 * 16000 * 2);
    expect(out.toString("ascii", 0, 4)).toBe("RIFF");
    expect(out.readUInt32LE(40)).toBe(3 * 16000 * 2);
  });
});
