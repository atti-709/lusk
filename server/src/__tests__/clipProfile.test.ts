import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClipSettings, parseContentProfile } from "@lusk/shared";
import {
  buildClipUserMessage,
  clipLengthRange,
  maxClipsFor,
  minClipMsFor,
  renderSermonPrompt,
} from "../services/clipProfile.js";
import { CLIP_SCHEMA } from "../services/GeminiService.js";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../client/public/prompts");

/** The request exactly as GeminiService.detectViralClips built it before content profiles existed. */
function legacyMaxClips(lastTimestamp: string): number {
  const [h, m, sec] = lastTimestamp.split(":").map(Number);
  const totalSec = (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
  return Math.max(3, Math.min(16, Math.floor(totalSec / 35)));
}
function legacyMessage(prompt: string, lastTimestamp: string, correctedTsv: string): string {
  return [
    prompt,
    "",
    `CONSTRAINT: The transcript ends at ${lastTimestamp}. All start and end timestamps MUST fall within 00:00:00.000 – ${lastTimestamp}. Do NOT suggest clips that extend beyond this range.`,
    `CONSTRAINT: Return at most ${legacyMaxClips(lastTimestamp)} clips, none overlapping another.`,
    "",
    "## Corrected Transcript (.tsv):",
    "",
    correctedTsv,
  ].join("\n");
}

describe("podcast profile is unchanged", () => {
  const tsv = "00:00:00.000\tVeta\n00:00:01.000\tdruhá.";

  it("sends byte for byte the legacy request, for every transcript length", async () => {
    const prompt = await readFile(join(promptsDir, "viral-clips-api.md"), "utf-8");
    for (const last of ["00:00:20.000", "00:02:00.000", "00:09:59.500", "00:30:00.000", "01:30:12.345", "03:00:00.000"]) {
      expect(buildClipUserMessage(prompt, last, tsv)).toBe(legacyMessage(prompt, last, tsv));
      expect(buildClipUserMessage(prompt, last, tsv, "podcast", {})).toBe(legacyMessage(prompt, last, tsv));
      expect(maxClipsFor(last)).toBe(legacyMaxClips(last));
    }
  });

  it("keeps the 20-30 s range and the 15 s fragment floor", () => {
    expect(clipLengthRange("podcast")).toEqual({ minSec: 20, maxSec: 30 });
    expect(minClipMsFor("podcast")).toBe(15_000);
  });

  it("keeps the response schema", () => {
    const item = (CLIP_SCHEMA.properties.clips.items as { required: string[] });
    expect(item.required).toEqual(["title", "hook", "takeaway", "start", "end", "hook_score", "flow_score", "value_score", "reach_score", "score_reason"]);
    expect(CLIP_SCHEMA.required).toEqual(["clips"]);
  });

  it("a project without the field is a podcast", () => {
    expect(parseContentProfile(undefined)).toBe("podcast");
    expect(parseContentProfile("nonsense")).toBe("podcast");
    expect(parseContentProfile("sermon")).toBe("sermon");
  });
});

describe("sermon profile", () => {
  it("counts one clip per 4 minutes, within 6-24", () => {
    expect(maxClipsFor("00:05:00.000", "sermon")).toBe(6);
    expect(maxClipsFor("00:24:00.000", "sermon")).toBe(6);
    expect(maxClipsFor("00:36:00.000", "sermon")).toBe(9);
    expect(maxClipsFor("00:45:00.000", "sermon")).toBe(11);
    expect(maxClipsFor("01:30:00.000", "sermon")).toBe(22);
    expect(maxClipsFor("02:00:00.000", "sermon")).toBe(24);
    expect(maxClipsFor("05:00:00.000", "sermon")).toBe(24);
  });

  it("asks for 30-60 s and fills the prompt's placeholders", async () => {
    const template = await readFile(join(promptsDir, "viral-clips-sermon.md"), "utf-8");
    expect(template).toContain("{{MIN_SEC}}");
    const rendered = renderSermonPrompt(template);
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain("30-60 seconds");
    expect(renderSermonPrompt(template, { minSec: 40, maxSec: 90 })).toContain("40-90 seconds");
    expect(minClipMsFor("sermon")).toBe(22_500);
  });

  it("overrides length and count, and appends instructions before the transcript", () => {
    const msg = buildClipUserMessage("PROMPT", "00:40:00.000", "TSV", "sermon", { count: 5, instructions: "Vyber len zvestovanie." });
    expect(msg).toContain("Return at most 5 clips");
    expect(msg).toContain("Vyber len zvestovanie.");
    expect(msg.indexOf("Vyber len zvestovanie.")).toBeLessThan(msg.indexOf("## Corrected Transcript"));
    expect(msg.endsWith("TSV")).toBe(true);
  });

  it("a podcast length override says it replaces the prompt's 20-30 s", () => {
    const msg = buildClipUserMessage("PROMPT", "00:10:00.000", "TSV", "podcast", { minSec: 15, maxSec: 45 });
    expect(msg).toContain("Every clip MUST be 15-45 seconds long");
    expect(minClipMsFor("podcast", { minSec: 15 })).toBe(11_250);
  });
});

describe("parseClipSettings", () => {
  it("drops unusable values and keeps max above min", () => {
    expect(parseClipSettings(undefined)).toEqual({});
    expect(parseClipSettings({ minSec: "40", maxSec: 20, count: 0, instructions: "  " })).toEqual({ minSec: 40, maxSec: 40, count: 1 });
    expect(parseClipSettings({ minSec: "abc", count: 9999, instructions: " hi " })).toEqual({ count: 60, instructions: "hi" });
  });
});
