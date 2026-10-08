import { describe, it, expect } from "vitest";
import { mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCopyOf, planPlayable, stampCopy } from "../services/PlayableVideo.js";

describe("planPlayable", () => {
  it("links delivery codecs whatever the container", () => {
    expect(planPlayable({ video: "h264", audio: "aac", durationSec: 10 }).direct).toBe(true);
    expect(planPlayable({ video: "hevc", audio: "pcm_s16le", durationSec: 10 }).direct).toBe(true);
    expect(planPlayable({ video: "h264", audio: null, durationSec: 10 }).direct).toBe(true);
  });

  it("re-encodes editing codecs to H.264, converting PCM audio for the MP4", () => {
    const plan = planPlayable({ video: "prores", audio: "pcm_s16le", durationSec: 10 });
    expect(plan.direct).toBe(false);
    expect(plan.videoArgs).toContain("h264_videotoolbox");
    expect(plan.audioArgs).toEqual(["-c:a", "aac", "-b:a", "256k"]);
  });

  it("copies streams that need no work", () => {
    const plan = planPlayable({ video: "dnxhd", audio: "aac", durationSec: 10 });
    expect(plan.audioArgs).toEqual(["-c:a", "copy"]);
    const audioOnly = planPlayable({ video: "h264", audio: "alac", durationSec: 10 });
    expect(audioOnly.direct).toBe(false);
    expect(audioOnly.videoArgs).toEqual(["-c:v", "copy"]);
  });

  it("leaves an unreadable probe alone", () => {
    expect(planPlayable({ video: null, audio: null, durationSec: null }).direct).toBe(true);
  });
});

describe("isCopyOf", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lusk-copy-"));
  const source = path.join(dir, "E01.mp4");
  writeFileSync(source, "master");

  it("recognises a stamped copy of the same source file", async () => {
    const target = path.join(dir, "copy.mp4");
    writeFileSync(target, "master");
    expect(await isCopyOf(source, target)).toBe(false);
    await stampCopy(source, target);
    expect(await isCopyOf(source, target)).toBe(true);
    expect(await isCopyOf(path.join(dir, "E02.mp4"), target)).toBe(false);
  });

  it("rejects a copy once the source changed", async () => {
    const target = path.join(dir, "stale.mp4");
    writeFileSync(target, "master");
    await stampCopy(source, target);
    utimesSync(source, new Date(), new Date(Date.now() + 5000));
    expect(await isCopyOf(source, target)).toBe(false);
  });

  it("never takes a symlink for a copy", async () => {
    const target = path.join(dir, "link.mp4");
    symlinkSync(source, target);
    await stampCopy(source, target);
    expect(await isCopyOf(source, target)).toBe(false);
  });
});
