export interface UploadResponse {
  success: boolean;
  sessionId: string;
  fileName: string;
  url: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

// Pipeline types

export type PipelineState =
  | "IDLE"
  | "UPLOADING"
  | "TRANSCRIBING"
  | "ALIGNING"
  | "ANALYZING"
  | "READY"
  | "RENDERING"
  | "EXPORTED";

export interface ProgressEvent {
  sessionId: string;
  state: PipelineState;
  progress: number;
  message: string;
}

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptData {
  words: TranscriptWord[];
  text: string;
}

export interface ViralClip {
  title: string;
  startMs: number;
  endMs: number;
  hookText: string;
}

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
}

export interface ProjectState {
  sessionId: string;
  state: PipelineState;
  progress: number;
  message: string;
  videoUrl: string | null;
  sourceScript: string | null;
  transcript: TranscriptData | null;
  captions: CaptionWord[] | null;
  viralClips: ViralClip[] | null;
  outputUrl: string | null;
}

export interface TranscribeRequest {
  sessionId: string;
}

export interface RenderRequest {
  sessionId: string;
}
