import { describe, it, expect } from "vitest";
import { computeClipLayout } from "../services/RenderService.js";

/** A range running this far past the end of the source (e.g. a generous trim). */
const OVERRUN_MS = 900;

const FPS = 24;
const SOURCE_MS = 2000; // 48 frames at 24fps → valid frame indices 0..47

/** Index of the last source frame the composition will ask OffthreadVideo for. */
const lastRequestedFrame = (l: { startFromInFrames: number; durationInFrames: number }) =>
  l.startFromInFrames + l.durationInFrames - 1;

describe("computeClipLayout", () => {
  it("never requests a frame past the end of the source", () => {
    // A range running past the video's end
    const layout = computeClipLayout(0, SOURCE_MS + OVERRUN_MS, FPS, SOURCE_MS);
    expect(lastRequestedFrame(layout)).toBe(47);
  });

  it("would overrun without a source duration — the frozen-tail case", () => {
    // Remotion repeats the last decoded frame rather than failing, so the overrun is silent
    const layout = computeClipLayout(0, SOURCE_MS + OVERRUN_MS, FPS);
    expect(lastRequestedFrame(layout)).toBeGreaterThan(47);
  });

  it("leaves a mid-video clip exactly as it was", () => {
    const clamped = computeClipLayout(500, 1200, FPS, SOURCE_MS);
    expect(clamped).toEqual(computeClipLayout(500, 1200, FPS));
  });

  it("clamps a clip the user trimmed past the end of the video", () => {
    const layout = computeClipLayout(1000, 60_000, FPS, SOURCE_MS);
    expect(lastRequestedFrame(layout)).toBe(47);
  });

  it("ignores an unknown source duration rather than truncating the clip", () => {
    const unclamped = computeClipLayout(0, 1500, FPS);
    expect(computeClipLayout(0, 1500, FPS, null)).toEqual(unclamped);
    expect(computeClipLayout(0, 1500, FPS, 0)).toEqual(unclamped);
  });

  it("keeps at least one frame even if the clip starts past the source end", () => {
    const layout = computeClipLayout(SOURCE_MS + 5000, SOURCE_MS + 8000, FPS, SOURCE_MS);
    expect(layout.durationInFrames).toBe(1);
  });

  it("does not change the frame-snapped start used for caption remapping", () => {
    const withSource = computeClipLayout(1234, 5000, FPS, SOURCE_MS);
    const without = computeClipLayout(1234, 5000, FPS);
    expect(withSource.startFromInFrames).toBe(without.startFromInFrames);
    expect(withSource.snappedStartMs).toBe(without.snappedStartMs);
  });
});
