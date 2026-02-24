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
  text?: string;
  words: TranscriptWord[];
}

export interface SessionSummary {
  sessionId: string;
  state: PipelineState;
  videoUrl: string | null;
  videoName: string | null;
  createdAt: string;
}

export interface ViralClip {
  title: string;
  startMs: number;
  endMs: number;
  hookText: string;
  // UI State Persistence
  captionEdits?: Record<number, string>;
  captionOffset?: number;
  trimStartDelta?: number;
  trimEndDelta?: number;
  speakerOffsetX?: number;
}

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
}

export interface ClipRenderState {
  status: 'rendering' | 'exported';
  progress: number;
  message: string;
  outputUrl: string | null;
}

export interface ProjectState {
  sessionId: string;
  state: PipelineState;
  progress: number;
  message: string;
  videoUrl: string | null;
  videoName: string | null;

  transcript: TranscriptData | null;
  correctedTranscriptRaw?: string | null;
  captions: CaptionWord[] | null;
  viralClips: ViralClip[] | null;
  outputUrl: string | null;
  renders: Record<string, ClipRenderState>;
}

export interface TranscribeRequest {
  sessionId: string;
}

export interface RenderRequest {
  sessionId: string;
  clip: ViralClip;
  offsetX: number;
  captions?: CaptionWord[];
}

export interface ImportResponse {
  success: boolean;
  sessionId: string;
  videoName: string | null;
}

