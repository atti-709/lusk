import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "../services/Orchestrator.js";
import type { ProgressEvent } from "@lusk/shared";

describe("Orchestrator", () => {
  let orc: Orchestrator;

  beforeEach(() => {
    orc = new Orchestrator();
  });

  it("createSession() initializes session at UPLOADING/100%", () => {
    const state = orc.createSession("s1", "/static/s1/input.mp4");
    expect(state.sessionId).toBe("s1");
    expect(state.state).toBe("UPLOADING");
    expect(state.progress).toBe(100);
    expect(state.videoUrl).toBe("/static/s1/input.mp4");
    expect(state.transcript).toBeNull();
    expect(state.viralClips).toBeNull();
    expect(state.outputUrl).toBeNull();
    expect(state.renders).toEqual({});
  });

  it("transition() follows valid state flow", () => {
    orc.createSession("s1", "/v.mp4");
    orc.transition("s1", "TRANSCRIBING");
    expect(orc.toProjectState("s1")!.state).toBe("TRANSCRIBING");

    orc.transition("s1", "ALIGNING");
    expect(orc.toProjectState("s1")!.state).toBe("ALIGNING");

    orc.transition("s1", "READY");
    expect(orc.toProjectState("s1")!.state).toBe("READY");
  });

  it("transition() throws on invalid transition", () => {
    orc.createSession("s1", "/v.mp4");
    expect(() => orc.transition("s1", "READY")).toThrow(
      "Invalid transition: UPLOADING → READY"
    );
  });

  it("transition() throws for unknown session", () => {
    expect(() => orc.transition("nope", "TRANSCRIBING")).toThrow(
      "Session not found: nope"
    );
  });

  it("READY allows going back to ALIGNING but not RENDERING", () => {
    orc.createSession("s1", "/v.mp4");
    orc.transition("s1", "TRANSCRIBING");
    orc.transition("s1", "ALIGNING");
    orc.transition("s1", "READY");

    // Can go back to ALIGNING
    orc.transition("s1", "ALIGNING");
    expect(orc.toProjectState("s1")!.state).toBe("ALIGNING");

    // Can go forward again
    orc.transition("s1", "READY");
    expect(() => orc.transition("s1", "RENDERING")).toThrow(
      "Invalid transition: READY → RENDERING"
    );
  });

  it("updateProgress() clamps values 0-100", () => {
    orc.createSession("s1", "/v.mp4");

    orc.updateProgress("s1", 150, "over");
    expect(orc.toProjectState("s1")!.progress).toBe(100);

    orc.updateProgress("s1", -10, "under");
    expect(orc.toProjectState("s1")!.progress).toBe(0);

    orc.updateProgress("s1", 42, "normal");
    expect(orc.toProjectState("s1")!.progress).toBe(42);
  });

  it("emits progress events on createSession, transition, updateProgress", () => {
    const events: ProgressEvent[] = [];
    orc.on("progress", (e: ProgressEvent) => events.push(e));

    orc.createSession("s1", "/v.mp4");
    orc.transition("s1", "TRANSCRIBING");
    orc.updateProgress("s1", 50, "halfway");

    expect(events).toHaveLength(3);
    expect(events[0].state).toBe("UPLOADING");
    expect(events[1].state).toBe("TRANSCRIBING");
    expect(events[2].progress).toBe(50);
    expect(events[2].message).toBe("halfway");
  });

  it("setTranscript() stores transcript data", () => {
    orc.createSession("s1", "/v.mp4");
    const transcript = { text: "ahoj", words: [{ word: "ahoj", startMs: 0, endMs: 500 }] };
    orc.setTranscript("s1", transcript);
    expect(orc.toProjectState("s1")!.transcript).toEqual(transcript);
  });

  it("setViralClips() stores clip data", () => {
    orc.createSession("s1", "/v.mp4");
    const clips = [{ title: "Hook", startMs: 0, endMs: 30000, hookText: "Wow" }];
    orc.setViralClips("s1", clips);
    expect(orc.toProjectState("s1")!.viralClips).toEqual(clips);
  });

  it("setOutputUrl() stores output URL", () => {
    orc.createSession("s1", "/v.mp4");
    orc.setOutputUrl("s1", "/static/s1/output.mp4");
    expect(orc.toProjectState("s1")!.outputUrl).toBe("/static/s1/output.mp4");
  });

  it("updateClipRender() stores per-clip render state", () => {
    orc.createSession("s1", "/v.mp4");
    orc.updateClipRender("s1", "0-30000", {
      status: "rendering",
      progress: 50,
      message: "Rendering...",
      outputUrl: null,
    });
    const state = orc.toProjectState("s1")!;
    expect(state.renders["0-30000"]).toEqual({
      status: "rendering",
      progress: 50,
      message: "Rendering...",
      outputUrl: null,
    });
  });

  it("updateClipRender() tracks multiple clips independently", () => {
    orc.createSession("s1", "/v.mp4");
    orc.updateClipRender("s1", "0-30000", {
      status: "exported",
      progress: 100,
      message: "Done",
      outputUrl: "/static/s1/output_0-30000.mp4",
    });
    orc.updateClipRender("s1", "30000-60000", {
      status: "rendering",
      progress: 25,
      message: "Rendering...",
      outputUrl: null,
    });
    const state = orc.toProjectState("s1")!;
    expect(state.renders["0-30000"].status).toBe("exported");
    expect(state.renders["30000-60000"].status).toBe("rendering");
  });

  it("updateClipRender() emits progress event", () => {
    const events: ProgressEvent[] = [];
    orc.on("progress", (e: ProgressEvent) => events.push(e));
    orc.createSession("s1", "/v.mp4");
    const countBefore = events.length;
    orc.updateClipRender("s1", "0-30000", {
      status: "rendering",
      progress: 10,
      message: "Starting...",
      outputUrl: null,
    });
    expect(events.length).toBe(countBefore + 1);
  });

  it("toProjectState() returns a copy, not a reference", () => {
    orc.createSession("s1", "/v.mp4");
    const copy = orc.toProjectState("s1")!;
    copy.state = "EXPORTED";
    expect(orc.toProjectState("s1")!.state).toBe("UPLOADING");
  });

  it("toProjectState() returns undefined for unknown session", () => {
    expect(orc.toProjectState("nope")).toBeUndefined();
  });
});
