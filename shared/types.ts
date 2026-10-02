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

/** A single contiguous clip range (in source-video milliseconds). */
export interface ClipRange {
  startMs: number;
  endMs: number;
}

/** Gemini's 1-100 sub-scores for a suggested clip. */
export interface ClipScores {
  /** Would the opening seconds stop a stranger's scroll? */
  hook: number;
  /** One self-contained thought that builds and lands cleanly? */
  flow: number;
  /** Does the viewer leave with something — insight, comfort, a laugh? */
  value: number;
  /** Does it work for someone outside the show's audience? */
  reach: number;
}

/** Hook-weighted composite of the sub-scores (OpusClip-style Hook/Flow/Value/Trend). */
export function viralityScore(s: ClipScores): number {
  return Math.round(0.35 * s.hook + 0.2 * s.flow + 0.25 * s.value + 0.2 * s.reach);
}

/**
 * How the 9:16 crop is positioned over a landscape source.
 * - `manual`: a fixed horizontal offset (`speakerOffsetX`)
 * - `face`: follows the biggest, most confident face
 * - `pick`: follows the person at `subjectX`, picked by hand
 * - `speaker`: gives the frame to whoever is talking and cuts between them
 */
export type FramingMode = "manual" | "face" | "pick" | "speaker";

export const DEFAULT_FRAMING_MODE: FramingMode = "speaker";

export interface ViralClip {
  title: string;
  /** Base clip start in the source video (sentence boundary). */
  startMs: number;
  /** Base clip end in the source video (sentence boundary). */
  endMs: number;
  hookText: string;
  /** Gemini's one-sentence summary of the key insight. */
  takeaway?: string;
  /** Gemini's sub-scores; absent on clips added by hand or parsed from manual output. */
  scores?: ClipScores;
  /** Composite 1-100 score (see `viralityScore`). */
  viralityScore?: number;
  /** One sentence naming the clip's strongest and weakest aspect. */
  scoreReason?: string;
  // UI State Persistence
  captionEdits?: Record<number, string>;
  captionOffset?: number;
  /** User trim relative to `startMs` (ms; negative = earlier start). */
  trimStartDelta?: number;
  /** User trim relative to `endMs` (ms; defaults to CLIP_TRAILING_MARGIN_MS). */
  trimEndDelta?: number;
  speakerOffsetX?: number;
}

/** Whisper timestamps tend to be slightly early; default trailing margin so the last word's audio fully plays. */
export const CLIP_TRAILING_MARGIN_MS = 900;

/** Returns the effective source range to render, applying user trim deltas. */
export function getClipRange(clip: ViralClip): ClipRange {
  return {
    startMs: clip.startMs + (clip.trimStartDelta ?? 0),
    endMs: clip.endMs + (clip.trimEndDelta ?? CLIP_TRAILING_MARGIN_MS),
  };
}

/** Stable render key derived from the effective (trimmed) range: `${startMs}-${endMs}`. */
export function getClipRenderKey(clip: ViralClip): string {
  const { startMs, endMs } = getClipRange(clip);
  return `${startMs}-${endMs}`;
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

