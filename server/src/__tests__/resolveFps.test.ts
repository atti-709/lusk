import { describe, it, expect } from "vitest";
import { MATCH_SOURCE_FPS, resolveFps } from "@lusk/shared";

describe("resolveFps", () => {
  it("renders at the source's rate when the setting is Match source", () => {
    expect(resolveFps(MATCH_SOURCE_FPS, 25)).toBe(25);
    expect(resolveFps(undefined, 30000 / 1001)).toBeCloseTo(29.97, 2);
  });

  it("keeps a fixed rate the user chose", () => {
    expect(resolveFps(23.976, 25)).toBe(23.976);
  });

  it("falls back to 23.976 when the source rate is unknown", () => {
    expect(resolveFps(MATCH_SOURCE_FPS, null)).toBe(23.976);
  });
});
