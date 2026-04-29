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

export interface ClipSegment {
  startMs: number;
  endMs: number;
}

export interface ViralClip {
  title: string;
  startMs: number;
  endMs: number;
  hookText: string;
  // Multi-cut: when present, render plays these segments back-to-back.
  // When absent, falls back to a single segment derived from startMs/endMs + trim deltas.
  segments?: ClipSegment[];
  // UI State Persistence (trim deltas only used when segments is absent)
  captionEdits?: Record<number, string>;
  captionOffset?: number;
  trimStartDelta?: number;
  trimEndDelta?: number;
  speakerOffsetX?: number;
}

/** Whisper timestamps tend to be slightly early; default trailing margin so the last caption fully shows. */
export const CLIP_TRAILING_MARGIN_MS = 900;

/** Returns the segments to actually render. Falls back to startMs/endMs + trim deltas for legacy clips. */
export function getClipSegments(clip: ViralClip): ClipSegment[] {
  if (clip.segments && clip.segments.length > 0) return clip.segments;
  return [{
    startMs: clip.startMs + (clip.trimStartDelta ?? 0),
    endMs: clip.endMs + (clip.trimEndDelta ?? CLIP_TRAILING_MARGIN_MS),
  }];
}

/** Stable render key — single-segment clips keep the legacy `${startMs}-${endMs}` format for backwards compat with existing rendered files. */
export function getClipRenderKey(clip: { startMs: number; endMs: number; segments?: ClipSegment[] }): string {
  if (clip.segments && clip.segments.length > 1) {
    return clip.segments.map((s) => `${s.startMs}-${s.endMs}`).join("_");
  }
  if (clip.segments && clip.segments.length === 1) {
    return `${clip.segments[0].startMs}-${clip.segments[0].endMs}`;
  }
  return `${clip.startMs}-${clip.endMs}`;
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
  fontFamily: string;
  highlightColor: string;
  textColor: string;
  textTransform: "uppercase" | "none" | "capitalize";
  captionPosition: number;
  fontWeight: number;
}

export const DEFAULT_CAPTION_STYLES: CaptionStyles = {
  fontSize: 56,
  fontFamily: "Space Grotesk",
  highlightColor: "#FF4F26",
  textColor: "#faf9f8",
  textTransform: "uppercase",
  captionPosition: 400,
  fontWeight: 700,
};

export interface ClipRenderState {
  status: 'rendering' | 'exported' | 'error';
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

