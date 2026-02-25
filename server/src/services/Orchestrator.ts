import { EventEmitter } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PipelineState,
  ProjectState,
  ProgressEvent,
  TranscriptData,
  CaptionWord,
  ViralClip,
  ClipRenderState,
} from "@lusk/shared";
import { tempManager } from "./TempManager.js";

const TRANSITIONS: Record<PipelineState, PipelineState[]> = {
  IDLE: ["UPLOADING"],
  UPLOADING: ["TRANSCRIBING"],
  TRANSCRIBING: ["ALIGNING"],
  ALIGNING: ["READY"],
  READY: ["ALIGNING"],
  RENDERING: ["EXPORTED", "READY"],
  EXPORTED: ["READY"],
};

class Orchestrator extends EventEmitter {
  private sessions = new Map<string, ProjectState>();
  private writeQueue = new Map<string, Promise<void>>();

  createSession(id: string, videoUrl: string, videoName: string | null = null, videoDurationMs: number | null = null): ProjectState {
    const state: ProjectState = {
      sessionId: id,
      state: "UPLOADING",
      progress: 100,
      message: "Upload complete",
      videoUrl,
      videoName,
      videoDurationMs,

      transcript: null,
      correctedTranscriptRaw: null,
      captions: null,
      viralClips: null,
      outputUrl: null,
      renders: {},
    };
    this.sessions.set(id, state);
    this.emitProgress(state);
    this.persistSession(id);
    return state;
  }

  restoreSession(state: ProjectState): void {
    this.sessions.set(state.sessionId, state);
  }

  getSession(id: string): ProjectState | undefined {
    return this.sessions.get(id);
  }

  transition(id: string, newState: PipelineState): void {
    const session = this.requireSession(id);
    const allowed = TRANSITIONS[session.state];
    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid transition: ${session.state} → ${newState}`
      );
    }
    session.state = newState;
    session.progress = 0;
    session.message = "";
    this.emitProgress(session);
    this.persistSession(id);
  }

  updateProgress(id: string, percent: number, message: string): void {
    const session = this.requireSession(id);
    session.progress = Math.max(0, Math.min(100, percent));
    session.message = message;
    this.emitProgress(session);
  }



  setTranscript(id: string, transcript: TranscriptData): void {
    const session = this.requireSession(id);
    session.transcript = transcript;
    this.persistSession(id);
  }

  setCorrectedTranscriptRaw(id: string, text: string): void {
    const session = this.requireSession(id);
    session.correctedTranscriptRaw = text;
    this.persistSession(id);
  }

  setCaptions(id: string, captions: CaptionWord[]): void {
    const session = this.requireSession(id);
    session.captions = captions;
    this.persistSession(id);
  }

  setViralClips(id: string, clips: ViralClip[]): void {
    const session = this.requireSession(id);
    session.viralClips = clips;
    this.persistSession(id);
  }

  setOutputUrl(id: string, url: string | null): void {
    const session = this.requireSession(id);
    session.outputUrl = url;
    this.persistSession(id);
  }

  updateClipRender(id: string, clipKey: string, renderState: ClipRenderState): void {
    const session = this.requireSession(id);
    if (!session.renders) session.renders = {};
    session.renders[clipKey] = renderState;
    this.emitProgress(session);
    this.persistSession(id);
  }

  toProjectState(id: string): ProjectState | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return { ...session };
  }

  private requireSession(id: string): ProjectState {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  /** Emit progress event and persist session to disk. */
  emitAndPersist(id: string): void {
    const session = this.requireSession(id);
    this.emitProgress(session);
    this.persistSession(id);
  }

  private emitProgress(session: ProjectState): void {
    const event: ProgressEvent = {
      sessionId: session.sessionId,
      state: session.state,
      progress: session.progress,
      message: session.message,
    };
    this.emit("progress", event);
  }

  private persistSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    // Serialize writes per session to prevent file corruption
    const prev = this.writeQueue.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const dir = tempManager.getSessionDir(id);
      const data = JSON.stringify(session, null, 2);
      const meta = JSON.stringify({
        sessionId: session.sessionId,
        state: session.state,
        videoUrl: session.videoUrl,
        videoName: session.videoName ?? null,
      });
      await writeFile(join(dir, "session.json"), data);
      await writeFile(join(dir, "session-meta.json"), meta);
    }).catch(() => {});
    this.writeQueue.set(id, next);
  }
}

export const orchestrator = new Orchestrator();
export { Orchestrator };
