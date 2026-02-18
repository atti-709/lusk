import { EventEmitter } from "node:events";
import type {
  PipelineState,
  ProjectState,
  ProgressEvent,
  TranscriptData,
  ViralClip,
} from "@lusk/shared";

const TRANSITIONS: Record<PipelineState, PipelineState[]> = {
  IDLE: ["UPLOADING"],
  UPLOADING: ["TRANSCRIBING"],
  TRANSCRIBING: ["ALIGNING"],
  ALIGNING: ["ANALYZING"],
  ANALYZING: ["READY"],
  READY: ["RENDERING"],
  RENDERING: ["EXPORTED"],
  EXPORTED: [],
};

class Orchestrator extends EventEmitter {
  private sessions = new Map<string, ProjectState>();

  createSession(id: string, videoUrl: string): ProjectState {
    const state: ProjectState = {
      sessionId: id,
      state: "UPLOADING",
      progress: 100,
      message: "Upload complete",
      videoUrl,
      transcript: null,
      viralClips: null,
      outputUrl: null,
    };
    this.sessions.set(id, state);
    this.emitProgress(state);
    return state;
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
  }

  setViralClips(id: string, clips: ViralClip[]): void {
    const session = this.requireSession(id);
    session.viralClips = clips;
  }

  setOutputUrl(id: string, url: string): void {
    const session = this.requireSession(id);
    session.outputUrl = url;
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

  private emitProgress(session: ProjectState): void {
    const event: ProgressEvent = {
      sessionId: session.sessionId,
      state: session.state,
      progress: session.progress,
      message: session.message,
    };
    this.emit("progress", event);
  }
}

export const orchestrator = new Orchestrator();
export { Orchestrator };
