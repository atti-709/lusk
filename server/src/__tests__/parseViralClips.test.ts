import { describe, it, expect } from "vitest";
import { parseViralClipText } from "../routes/align.js";

describe("parseViralClipText (single-cut only)", () => {
  it("parses a Cut 1 line into a contiguous clip", () => {
    const text = [
      "CLIP 1",
      "Title: The Big Reveal",
      "Hook: You won't believe this",
      "Takeaway: Insight here",
      "Cut 1: 00:01:23.456 - 00:01:45.900",
    ].join("\n");

    const clips = parseViralClipText(text);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      title: "The Big Reveal",
      hookText: "You won't believe this",
      startMs: 83456,
      endMs: 105900,
    });
    // No multi-cut field should exist anymore.
    expect("segments" in clips[0]).toBe(false);
  });

  it("parses the legacy Start:/End: format", () => {
    const text = [
      "CLIP 1",
      "Title: Legacy",
      "Hook: hook",
      "Start: 00:00:10.000",
      "End: 00:00:35.000",
    ].join("\n");

    const clips = parseViralClipText(text);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ startMs: 10000, endMs: 35000 });
  });

  it("ignores any extra Cut lines and keeps only the first cut", () => {
    const text = [
      "CLIP 1",
      "Title: Should Not Splice",
      "Hook: hook",
      "Cut 1: 00:00:05.000 - 00:00:25.000",
      "Cut 2: 00:02:00.000 - 00:02:10.000",
    ].join("\n");

    const clips = parseViralClipText(text);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ startMs: 5000, endMs: 25000 });
    expect("segments" in clips[0]).toBe(false);
  });

  it("skips clips with an invalid (non-positive) range", () => {
    const text = [
      "CLIP 1",
      "Title: Bad",
      "Cut 1: 00:00:30.000 - 00:00:10.000",
    ].join("\n");

    expect(parseViralClipText(text)).toHaveLength(0);
  });

  it("parses multiple CLIP blocks", () => {
    const text = [
      "CLIP 1",
      "Title: One",
      "Cut 1: 00:00:00.000 - 00:00:22.000",
      "CLIP 2",
      "Title: Two",
      "Cut 1: 00:01:00.000 - 00:01:24.000",
    ].join("\n");

    const clips = parseViralClipText(text);
    expect(clips.map((c) => c.title)).toEqual(["One", "Two"]);
  });
});
