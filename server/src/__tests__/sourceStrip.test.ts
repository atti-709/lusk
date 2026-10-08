import { describe, it, expect } from "vitest";
import { sourceStripFor } from "../services/sourceStrip.js";

describe("sourceStripFor", () => {
  it("keeps just the crop window around a still camera, with a small even margin", () => {
    // 4K source: the 9:16 window is 2160 × 9/16 = 1215 px wide
    const s = sourceStripFor(3840, 2160, [{ t: 0, cx: 0.44748 }, { t: 24.78, cx: 0.44748 }], 0, null)!;
    expect(s.px.x % 2).toBe(0);
    expect(s.px.w % 2).toBe(0);
    expect(s.px.x).toBeLessThanOrEqual(0.44748 * 3840 - 1215 / 2 - 4);
    expect(s.px.x + s.px.w).toBeGreaterThanOrEqual(0.44748 * 3840 + 1215 / 2 + 4);
    expect(s.px.w).toBeLessThan(1240);
    expect(s.x).toBeCloseTo(s.px.x / 3840);
    expect(s.w).toBeCloseTo(s.px.w / 3840);
  });

  it("spans every crop position a tracked camera visits", () => {
    const s = sourceStripFor(3840, 2160, [{ t: 0, cx: 0.3 }, { t: 5, cx: 0.3 }, { t: 5.01, cx: 0.55 }], 0, null)!;
    expect(s.px.x).toBeLessThanOrEqual(0.3 * 3840 - 1215 / 2);
    expect(s.px.x + s.px.w).toBeGreaterThanOrEqual(0.55 * 3840 + 1215 / 2);
  });

  it("clamps centers at the edges like the composition does", () => {
    const s = sourceStripFor(3840, 2160, [{ t: 0, cx: 0.02 }], 0, null)!;
    expect(s.px.x).toBe(0);
    expect(s.px.w).toBeGreaterThanOrEqual(1215);
    expect(s.px.w).toBeLessThan(1230);
  });

  it("follows a manual offset when there is no tracking", () => {
    // offsetX shifts the video right, so the window sits left of center
    const videoWidth = 1920 * (16 / 9);
    const s = sourceStripFor(1920, 1080, null, 400, null)!;
    const cx = 0.5 - 400 / videoWidth;
    expect(s.px.x).toBeLessThanOrEqual((cx - 1080 / 2 / videoWidth) * 1920);
    expect(s.px.x + s.px.w).toBeGreaterThanOrEqual((cx + 1080 / 2 / videoWidth) * 1920);
  });

  it("needs the whole frame for graphics shown whole, portrait sources and wide pans", () => {
    expect(sourceStripFor(3840, 2160, [{ t: 0, cx: 0.5 }], 0, [[1, 3]])).toBeNull();
    expect(sourceStripFor(1080, 1920, [{ t: 0, cx: 0.5 }], 0, null)).toBeNull();
    expect(sourceStripFor(3840, 2160, [{ t: 0, cx: 0.1 }, { t: 9, cx: 0.9 }], 0, null)).toBeNull();
  });
});
