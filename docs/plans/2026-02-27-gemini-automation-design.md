# Gemini API Automation Design

## Goal

Replace the manual copy/paste Gemini workflow (download TSV, copy prompt, paste into Gemini chat, paste results back) with automated server-side Gemini API calls. The full pipeline becomes: upload video + optional script → transcribe → auto-correct with Gemini → auto-detect viral clips → ready.

## Decisions

- **Architecture:** Server-side Gemini integration (API key stays secure on server)
- **Model:** `gemini-2.5-pro` via `@google/genai` npm package
- **Script input:** Optional `.md` file drop zone on IDLE screen alongside video
- **Fallback:** If no API key or no script, fall back to existing manual AlignStep
- **Viral clips:** Always auto-run after correction completes
- **API key storage:** Settings UI in the app, persisted to `~/.lusk/config.json`

## Modified IDLE Screen

The IDLE state currently shows a single video drop zone. It gets extended:

```
┌─────────────────────────────────────────────┐
│              Add a source video              │
│     [drag & drop video or click browse]      │
│            ┌─────────────────┐               │
│            │  Browse files   │               │
│            └─────────────────┘               │
├─────────────────────────────────────────────┤
│         Add reference script (optional)      │
│     [drag & drop .md file or click browse]   │
│         filename.md ✓  (or empty)            │
└─────────────────────────────────────────────┘
```

- Video drop zone (existing, unchanged)
- Script drop zone (new) — accepts `.md` files. Shows filename when loaded.
- The "Start Transcription" button appears after video is selected (UPLOADING state), same as today.

When a script file is dropped, the client reads its text content and sends it to `POST /api/projects/:projectId/script`.

## Pipeline Flow

State machine unchanged: `IDLE → UPLOADING → TRANSCRIBING → ALIGNING → READY`

### What changes at each transition:

1. **IDLE → UPLOADING**: User drops video (+ optional script). Script text stored in session.
2. **UPLOADING → TRANSCRIBING**: User clicks "Start Transcription". WhisperX runs (unchanged).
3. **TRANSCRIBING → ALIGNING**: After WhisperX finishes:
   - **If script + API key available**: Auto-runs GeminiService for correction, then viral clips. Progress reported via SSE.
   - **If no script OR no API key**: Shows existing manual AlignStep (fallback).
4. **ALIGNING → READY**: After Gemini returns (or manual submit), transition to READY.

## GeminiService (`server/src/services/GeminiService.ts`)

New service handling all Gemini API interactions.

### Correction Flow:
1. Read correction prompt from `client/public/prompts/correction.md`
2. Convert transcript words to TSV format
3. If >2000 lines, chunk into 2000-line pieces
4. For each chunk: call Gemini Pro with `{correction_prompt}\n\nScript:\n{script_text}\n\nTSV:\n{chunk_tsv}`
5. Parse returned TSV from code block in response
6. Report per-chunk progress via callback

### Viral Clip Detection Flow:
1. Read viral-clips prompt from `client/public/prompts/viral-clips.md`
2. Send full corrected transcript TSV + viral-clips prompt
3. Parse CLIP format response (reuse existing `parseViralClipText` logic from `align.ts`)

### Error Handling:
- If Gemini fails: session stays in ALIGNING with error message
- User can fall back to manual workflow from this state

## Settings / API Key

- Config file: `~/.lusk/config.json` → `{ "geminiApiKey": "..." }`
- Server routes: `GET /api/settings`, `PUT /api/settings`
- Client: Settings dialog (gear icon in header) to enter/save Gemini API key
- Server also checks `GEMINI_API_KEY` env var as fallback (env var takes precedence)

## Data Model Changes

### `ProjectState` / `ProjectData` (shared/types.ts):
- Add `scriptText: string | null` — the uploaded reference script content

### New server route:
- `POST /api/projects/:projectId/script` — stores script text in session

### Modified transcription route:
- After transcription completes, check for script + API key → auto-call GeminiService

## Chunking Strategy

Same as existing download logic: 2000-line chunks. Each chunk is sent as a separate Gemini API call. Results are concatenated in order.

## Files to Create/Modify

### New files:
- `server/src/services/GeminiService.ts` — Gemini API service
- `server/src/routes/settings.ts` — settings CRUD routes

### Modified files:
- `shared/types.ts` — add `scriptText` to ProjectData/ProjectState
- `server/src/services/Orchestrator.ts` — add `setScriptText()` method
- `server/src/routes/transcribe.ts` — auto-trigger Gemini after transcription
- `server/src/routes/align.ts` — add script upload route
- `server/src/index.ts` — register settings routes
- `client/src/App.tsx` — add script drop zone to IDLE screen
- `client/src/components/PipelineStepper.tsx` — conditionally show manual vs auto align
- `client/src/components/AlignStep.tsx` — keep as fallback when no API key/script
- `server/src/services/ProjectFileService.ts` — persist/restore scriptText
- `server/package.json` — add `@google/genai` dependency
