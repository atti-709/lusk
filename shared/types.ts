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

export interface TranslatedBlock {
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionStyles {
  fontSize: number;
  highlightColor: string;
  textColor: string;
  textTransform: "uppercase" | "none" | "capitalize";
  captionPosition: number;
  fontWeight: 800 | 900;
}

export const DEFAULT_CAPTION_STYLES: CaptionStyles = {
  fontSize: 56,
  highlightColor: "#F77205",
  textColor: "#ffffff",
  textTransform: "uppercase",
  captionPosition: 340,
  fontWeight: 900,
};

export interface ClipRenderState {
  status: 'rendering' | 'exported';
  progress: number;
  message: string;
  outputUrl: string | null;
}

// Persisted project data (saved to .lusk files)
export interface ProjectData {
  version: number;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  videoPath: string;
  videoName: string;
  videoDurationMs: number | null;
  videoWidth: number | null;   // source pixel width
  videoHeight: number | null;  // source pixel height
  state: PipelineState;
  transcript: TranscriptData | null;
  originalTranscript?: TranscriptData | null;
  correctedTranscriptRaw?: string | null;
  scriptText?: string | null;
  captions: CaptionWord[] | null;
  translatedCaptions?: TranslatedBlock[] | null;
  viralClips: ViralClip[] | null;
}

// Runtime project state (extends persisted data with runtime-only fields)
export interface ProjectState extends ProjectData {
  sessionId: string; // alias for projectId, kept for backwards compat
  videoUrl: string | null;
  progress: number;
  message: string;
  renders: Record<string, ClipRenderState>;
  outputUrl: string | null;
  projectFilePath: string | null;
}

// Recent project entry for the dashboard registry
export interface RecentProject {
  projectId: string;
  projectPath: string;
  videoName: string;
  state: PipelineState;
  updatedAt: string;
  thumbnail: string | null;
  missing?: boolean;
}

// Native file dialog types
export interface BrowseRequest {
  type: "save" | "open";
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}

export interface BrowseResponse {
  canceled: boolean;
  filePath: string | null;
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

export interface OpenProjectResponse {
  success: boolean;
  projectId: string;
  videoName: string | null;
  state: PipelineState;
}

export interface CreateProjectResponse {
  success: boolean;
  projectId: string;
}

