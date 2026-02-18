# Phase 3: Alignment & Intelligence — Design

## Overview

Two server-side services: (1) optional Needleman-Wunsch text alignment to correct whisper transcript using user-provided source script, and (2) local LLM-based viral clip detection using node-llama-cpp.

## 1. Text Alignment (Optional)

**Service:** `server/src/services/AlignmentService.ts`

Aligns whisper transcript words with user-provided source text to correct diacritics and spelling errors common in Slovak ASR output.

**Algorithm:** Needleman-Wunsch global alignment at word level.
- Scoring: match=+2, mismatch=-1, gap=-1
- Preprocessing: strip diacritics and lowercase before comparing
- Output: replace each aligned whisper word with source word's correct spelling, preserving whisper's timestamps

**Trigger:** Only runs if user provides source text via `POST /api/project/:sessionId/script`. Pipeline auto-skips ALIGNING state if no script provided.

**Artifacts:** Saves `aligned-transcript.json` to session dir.

## 2. Viral Clip Detection (Local LLM)

**Service:** `server/src/services/LlmService.ts`

**Stack:** node-llama-cpp with Metal GPU acceleration on Apple Silicon.

**Model:** Meta-Llama-3-8B-Instruct.Q4_K_M.gguf (~4.7GB), stored in `server/models/`.

**Process:**
1. Send full transcript text to LLM
2. Prompt asks for 3-5 viral clip segments with title, hook text, and approximate quotes
3. Match LLM-returned text quotes back to transcript word timestamps for precise startMs/endMs
4. Return ViralClip[] array

**Artifacts:** Saves `viral-clips.json` to session dir.

## 3. Pipeline Flow

```
TRANSCRIBING → ALIGNING → ANALYZING → READY
                  ↓             ↓
           (skip if no    (LLM viral
            script)        detection)
```

## 4. New Endpoint

`POST /api/project/:sessionId/script` — accepts `{ text: string }` body with the source script. Stores it in the session for use during alignment.

## 5. Files

| File | Purpose |
|------|---------|
| `server/src/services/AlignmentService.ts` | Needleman-Wunsch + diacritics |
| `server/src/services/LlmService.ts` | node-llama-cpp viral detection |
| `server/src/routes/script.ts` | Accept source text endpoint |
| `server/src/__tests__/AlignmentService.test.ts` | Alignment unit tests |
