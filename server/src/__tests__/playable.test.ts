import { describe, it, expect } from "vitest";
import { planPlayable } from "../services/PlayableVideo.js";

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
