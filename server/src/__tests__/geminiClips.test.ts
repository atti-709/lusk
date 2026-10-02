import { describe, it, expect } from "vitest";
import type { TranscriptWord } from "@lusk/shared";
import { framingCenterAt, getFramingMode, viralityScore } from "@lusk/shared";
import { geminiClipsToViralClips } from "../routes/align.js";
import { parseClipResponse, stripEmbeddedImages, type GeminiClip } from "../services/GeminiService.js";

const words: TranscriptWord[] = Array.from({ length: 100 }, (_, i) => ({
  word: `w${i}`,
  startMs: i * 1000,
  endMs: i * 1000 + 800,
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
    expect(c).toMatchObject({ title: "Titul", hookText: "Hák", takeaway: "Pointa", startMs: 10_000, endMs: 35_000 });
    expect(c.scores).toEqual({ hook: 90, flow: 70, value: 80, reach: 60 });
    expect(c.viralityScore).toBe(Math.round(0.35 * 90 + 0.2 * 70 + 0.25 * 80 + 0.2 * 60));
    expect(c.scoreReason).toBe("Silný začiatok, slabší záver.");
  });

  it("snaps slightly-off and reformatted timestamps onto word starts", () => {
    const [c] = geminiClipsToViralClips([clip({ start: "00:10.400", end: "00:00:34.700" })], words, 100_000);
    expect(c.startMs).toBe(10_000);
    expect(c.endMs).toBe(35_000);
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
