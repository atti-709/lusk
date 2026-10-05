import { describe, it, expect } from "vitest";
import type { TranscriptWord } from "@lusk/shared";
import { framingCenterAt, getFramingMode, viralityScore } from "@lusk/shared";
import { geminiClipsToViralClips } from "../routes/align.js";
import { parseClipResponse, stripEmbeddedImages, type GeminiClip } from "../services/GeminiService.js";

// Each word a whole sentence, ending where the next starts (like a corrected transcript),
// so starts get no lead-in and boundaries stay put
const words: TranscriptWord[] = Array.from({ length: 100 }, (_, i) => ({
  word: `Veta${i}.`,
  startMs: i * 1000,
  endMs: i * 1000 + 1000,
}));

function clip(overrides: Partial<GeminiClip>): GeminiClip {
  return {
    title: "Titul",
    hook: "Hák",
    takeaway: "Pointa",
    start: "00:00:10.000",
    end: "00:00:35.000",
    hook_score: 90,
    flow_score: 70,
    value_score: 80,
    reach_score: 60,
    score_reason: "Silný začiatok, slabší záver.",
    ...overrides,
  };
}

describe("geminiClipsToViralClips", () => {
  it("parses timestamps and combines the scores", () => {
    const [c] = geminiClipsToViralClips([clip({})], words, 100_000);
    // ends just after the closing word (Veta34., 34.0-34.8 s), before the next one starts at 35 s
    expect(c).toMatchObject({ title: "Titul", hookText: "Hák", takeaway: "Pointa", startMs: 10_000, endMs: 34_940 });
    expect(c.scores).toEqual({ hook: 90, flow: 70, value: 80, reach: 60 });
    expect(c.viralityScore).toBe(Math.round(0.35 * 90 + 0.2 * 70 + 0.25 * 80 + 0.2 * 60));
    expect(c.scoreReason).toBe("Silný začiatok, slabší záver.");
  });

  it("snaps slightly-off and reformatted timestamps onto word starts", () => {
    const [c] = geminiClipsToViralClips([clip({ start: "00:10.400", end: "00:00:34.700" })], words, 100_000);
    expect(c.startMs).toBe(10_000);
    expect(c.endMs).toBe(34_940);
  });

  it("cuts in the pause after the closing word, not on the next sentence", () => {
    const paused: TranscriptWord[] = [
      { word: "Prvá", startMs: 0, endMs: 400 },
      { word: "veta.", startMs: 15_000, endMs: 15_900 },
      { word: "Druhá", startMs: 17_500, endMs: 17_900 }, // the next sentence, 1.6 s later
      { word: "veta.", startMs: 17_950, endMs: 18_400 },
    ];
    const [c] = geminiClipsToViralClips([clip({ start: "00:00:00.000", end: "00:00:17.500" })], paused, 18_400);
    expect(c.endMs).toBe(16_300); // 15.9 s + the 400 ms breath
  });

  // 1 s per word (800 ms spoken + 200 ms pause), the test sentences at 10-23 s between filler
  const filler = (n: number) => Array.from({ length: n }, () => "Výplň.");
  const sentences: TranscriptWord[] = [...filler(10), "Prvá", "veta.", "Keď", "sa", "ho", "pýtali,", "ako", "to", "robí,", "povedal", "nič.", "Koniec", "je", "Pán.", ...filler(30)]
    .map((word, i) => ({ word, startMs: i * 1000, endMs: i * 1000 + 800 }));
  const end = sentences.at(-1)!.endMs;

  it("moves a mid-sentence start back to the sentence's beginning", () => {
    const [c] = geminiClipsToViralClips([clip({ start: "00:00:16.000", end: "00:00:40.000" })], sentences, end);
    expect(c.startMs).toBe(11_900); // "ako" → "Keď" (12 s), less the lead-in
  });

  it("starts a little early, inside the pause before the first word", () => {
    const [c] = geminiClipsToViralClips([clip({ start: "00:00:12.000", end: "00:00:40.000" })], sentences, end);
    expect(c.startMs).toBe(11_900); // the previous word ends at 11.8 s; 100 ms of it stays silent
  });

  it("doesn't move a start back across a long silence", () => {
    const gap = sentences.map((w, i) => (i >= 16 ? { ...w, startMs: w.startMs + 5_000, endMs: w.endMs + 5_000 } : w));
    const [c] = geminiClipsToViralClips([clip({ start: "00:00:21.000", end: "00:00:45.000" })], gap, gap.at(-1)!.endMs);
    expect(c.startMs).toBe(20_800); // "ako" follows a 5 s hole: it keeps its start, with the full lead-in
  });

  it("leaves a capitalized start after a full stop where it is", () => {
    const [c] = geminiClipsToViralClips([clip({ start: "00:00:21.000", end: "00:00:40.000" })], sentences, end);
    expect(c.startMs).toBe(20_900); // "Koniec"
  });

  it("keeps a sentence's last word when the end points at it", () => {
    const [c] = geminiClipsToViralClips([clip({ start: "00:00:00.000", end: "00:00:23.000" })], sentences, end);
    expect(c.endMs).toBe(23_940); // through "Pán." (23.8 s), stopping short of the next word
  });

  it("drops fragments far shorter than a short", () => {
    expect(geminiClipsToViralClips([clip({ start: "00:00:10.000", end: "00:00:22.000" })], words, 100_000)).toHaveLength(0);
  });

  it("drops clips past the transcript end or with unreadable times", () => {
    const clips = geminiClipsToViralClips([
      clip({ start: "00:01:30.000", end: "00:02:30.000" }),
      clip({ start: "soon", end: "later" }),
      clip({ start: "00:00:40.000", end: "00:00:20.000" }),
    ], words, 100_000);
    expect(clips).toHaveLength(0);
  });

  it("clamps scores into 1-100 and sorts chronologically", () => {
    const clips = geminiClipsToViralClips([
      clip({ start: "00:00:50.000", end: "00:01:10.000", hook_score: 250 }),
      clip({ start: "00:00:05.000", end: "00:00:25.000", flow_score: -3 }),
    ], words, 100_000);
    expect(clips.map((c) => c.startMs)).toEqual([5_000, 50_000]);
    expect(clips[1].scores?.hook).toBe(100);
    expect(clips[0].scores?.flow).toBe(1);
  });
});

describe("geminiClipsToViralClips overlap", () => {
  it("keeps the stronger of two clips covering the same moment", () => {
    const clips = geminiClipsToViralClips([
      clip({ start: "00:00:01.000", end: "00:00:27.000", hook_score: 90 }),
      clip({ start: "00:00:05.000", end: "00:00:27.000", hook_score: 40 }),
      clip({ start: "00:00:20.000", end: "00:00:45.000", hook_score: 60 }), // 7 s of 26 shared — kept
    ], words, 100_000);
    expect(clips.map((c) => c.startMs)).toEqual([1_000, 20_000]);
  });
});

describe("parseClipResponse", () => {
  it("reads the clips array and tolerates a missing one", () => {
    expect(parseClipResponse(JSON.stringify({ clips: [clip({})] }))).toHaveLength(1);
    expect(parseClipResponse("{}")).toEqual([]);
  });
});

describe("viralityScore", () => {
  it("weights the hook most", () => {
    expect(viralityScore({ hook: 100, flow: 0, value: 0, reach: 0 })).toBe(35);
    expect(viralityScore({ hook: 50, flow: 50, value: 50, reach: 50 })).toBe(50);
  });
});

describe("framingCenterAt", () => {
  const kf = [
    { t: 0, cx: 0.3 },
    { t: 2, cx: 0.3 },
    { t: 3, cx: 0.5 },
    { t: 5.979, cx: 0.5 },
    { t: 5.98, cx: 0.8 },
  ];

  it("holds the ends and interpolates between keyframes", () => {
    expect(framingCenterAt(kf, -1)).toBe(0.3);
    expect(framingCenterAt(kf, 1)).toBe(0.3);
    expect(framingCenterAt(kf, 2.5)).toBeCloseTo(0.4);
    expect(framingCenterAt(kf, 10)).toBe(0.8);
  });

  it("steps at a cut", () => {
    expect(framingCenterAt(kf, 5.97)).toBe(0.5);
    expect(framingCenterAt(kf, 5.99)).toBe(0.8);
  });

  it("centers without keyframes", () => {
    expect(framingCenterAt([], 1)).toBe(0.5);
  });
});

describe("getFramingMode", () => {
  it("defaults to speaker tracking, but keeps hand-positioned clips manual", () => {
    const base = { title: "", startMs: 0, endMs: 1, hookText: "" };
    expect(getFramingMode(base)).toBe("speaker");
    expect(getFramingMode({ ...base, speakerOffsetX: 120 })).toBe("manual");
    expect(getFramingMode({ ...base, speakerOffsetX: 120, framingMode: "face" })).toBe("face");
  });
});

describe("stripEmbeddedImages", () => {
  it("removes Google Docs reference images and inline data URIs, keeping the text", () => {
    const md = [
      "Prvý odsek.",
      "![][image1]",
      "Druhý ![alt](data:image/png;base64,AAAA) odsek.",
      "",
      "[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==>",
      "",
      "[link]: https://example.com",
    ].join("\n");
    const out = stripEmbeddedImages(md);
    expect(out).not.toContain("data:");
    expect(out).not.toContain("![");
    expect(out).toContain("Prvý odsek.");
    expect(out).toContain("Druhý  odsek.");
    expect(out).toContain("[link]: https://example.com");
  });
});
