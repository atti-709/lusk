# Phase 2: Whisper.cpp Integration — Design

## Overview

Replace mock transcription with real Metal-accelerated whisper.cpp transcription using `@remotion/install-whisper-cpp`. Transcribes Slovak video podcast audio to word-level timestamped captions.

## Architecture

New `WhisperService` class in `server/src/services/WhisperService.ts` handles the full pipeline:

1. **Install whisper.cpp binary** — compiled with Metal support automatically on Apple Silicon
2. **Download model** — `large-v3-turbo` (~1.5GB, cached after first download)
3. **Extract audio** — FFmpeg converts input.mp4 to 16kHz 16-bit mono WAV (whisper requirement)
4. **Transcribe** — word-level timestamps via `tokenLevelTimestamps: true`, Slovak language, flash attention
5. **Convert** — `toCaptions()` produces `@remotion/captions` `Caption[]` format

## Data Flow

```
POST /api/transcribe { sessionId }
  → Orchestrator: UPLOADING → TRANSCRIBING
  → WhisperService.transcribe(sessionDir)
    → ffmpeg: input.mp4 → audio.wav (16kHz)
    → installWhisperCpp (first run only)
    → downloadWhisperModel (first run only)
    → transcribe({ language: "sk", model: "large-v3-turbo", ... })
    → toCaptions()
  → Orchestrator: store transcript + captions
  → Orchestrator: TRANSCRIBING → ALIGNING → ANALYZING → READY (mock phases 3+)
```

Progress mapping during TRANSCRIBING state:
- 0-5%: Extracting audio
- 5-15%: Installing binary / downloading model (skipped if cached)
- 15-95%: Whisper transcription (mapped from 0-1 onProgress callback)
- 95-100%: Converting to captions

## Config

- **Whisper binary path:** `server/whisper.cpp/`
- **Model:** `large-v3-turbo`
- **Whisper.cpp version:** `1.5.5`
- **Language:** `sk` (Slovak)
- **Flash attention:** enabled

## Type Changes

Add to `ProjectState` in `shared/types.ts`:
```typescript
captions: Caption[] | null;  // @remotion/captions Caption type
```

Also store raw whisper output as `TranscriptData` for alignment in Phase 3.

## Files

- **New:** `server/src/services/WhisperService.ts`
- **New:** `server/src/__tests__/WhisperService.test.ts`
- **Modify:** `server/src/routes/transcribe.ts` — replace mock with WhisperService
- **Modify:** `shared/types.ts` — add captions field
- **Modify:** `server/package.json` — add `@remotion/install-whisper-cpp`
- **Modify:** `.gitignore` — add `server/whisper.cpp/`

## Decisions

- Use `large-v3-turbo` for best speed/quality on Apple Silicon
- Metal acceleration is automatic at compile time (no config needed)
- Audio extraction via `child_process` FFmpeg call (assumed installed on macOS)
- Binary + model install is lazy (first transcription triggers it, subsequent runs skip)
- Raw whisper output stored alongside Caption[] for future alignment use
