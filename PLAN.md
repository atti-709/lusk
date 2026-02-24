# Plan: Replace Alignment & Analysis with Gemini-in-the-Loop

## Overview

Replace the automated AlignmentService (Needleman-Wunsch) and LlmService (node-llama-cpp) with a manual workflow where the user copies prompts, interacts with Gemini Pro externally, and pastes results back into the Lusk dashboard.

## New Pipeline Flow

```
UPLOADING → TRANSCRIBING → ALIGNING (manual, paused) → READY
```

The ALIGNING state becomes a **manual interactive step** where the user:
1. Downloads a `.tsv` file of the raw transcript
2. Copies a correction prompt (from `transcription-correction.md`)
3. Uploads the corrected `.tsv` file back
4. Copies a viral clip detection prompt
5. Pastes the Gemini viral clip results into a text-box
6. Clicks "Next" → server parses results, creates clips → READY

## Detailed Changes

---

### Step 1: Remove the "Original Script" textarea from Upload step

**File:** `client/src/components/PipelineStepper.tsx`
- Remove the `scriptText` state variable (line 41)
- Remove the entire `<div className="script-section">` block (lines 103-121) shown when `currentState === "UPLOADING"`
- Replace with a simple "Start Transcription" button (no script input needed)
- Update `PipelineStepperProps.onTranscribe` signature: remove the optional `sourceScript` parameter → just `onTranscribe: () => void`

**File:** `client/src/App.tsx`
- Simplify `handleTranscribe`: remove the `sourceScript` parameter and the script upload fetch call (lines 100-117). Just POST to `/api/transcribe`.

---

### Step 2: Update the Pipeline Steps display

**File:** `client/src/components/PipelineStepper.tsx`
- Remove the "ANALYZING" step from `STEPS` array. The new steps are:
  ```ts
  const STEPS = [
    { state: "UPLOADING", label: "Upload" },
    { state: "TRANSCRIBING", label: "Transcribe" },
    { state: "ALIGNING", label: "Align & Analyze" },
    { state: "READY", label: "Review" },
  ];
  ```

---

### Step 3: Modify Server Pipeline — Stop after transcription

**File:** `server/src/routes/transcribe.ts`
- After transcription completes, transition to `ALIGNING` and **stop** (don't run alignment or LLM analysis).
- Set a message like `"Transcript ready — download TSV and correct with Gemini"`.
- Remove all alignment code (lines 28-58) and LLM analysis code (lines 60-84) from `runTranscription()`.
- Remove imports of `alignTranscript` and `llmService`.

The new `runTranscription()` becomes:
```ts
async function runTranscription(sessionId, log) {
  const sessionDir = tempManager.getSessionDir(sessionId);
  orchestrator.transition(sessionId, "TRANSCRIBING");
  const { transcript, captions } = await whisperService.transcribe(sessionDir, (p, m) => {
    orchestrator.updateProgress(sessionId, p, m);
  });
  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.setCaptions(sessionId, captions);
  orchestrator.transition(sessionId, "ALIGNING");
  orchestrator.updateProgress(sessionId, 100, "Transcript ready — download and correct with Gemini");
}
```

---

### Step 4: Update State Machine

**File:** `server/src/services/Orchestrator.ts`
- Change `ALIGNING` transitions: `ALIGNING: ["READY"]` (skip ANALYZING entirely)
- Remove `ANALYZING` from the transitions map (or keep it unused — cleaner to remove)

**File:** `shared/types.ts`
- Remove `"ANALYZING"` from the `PipelineState` union type

---

### Step 5: New Server Endpoints

**File:** `server/src/routes/project.ts` (or new file `server/src/routes/align.ts`)

#### 5a. `GET /api/project/:sessionId/transcript.tsv`
- Read the session's transcript (`orchestrator.getSession(sessionId).transcript`)
- Convert `TranscriptWord[]` to TSV format: each line is `{startMs}\t{word}`
  - Format timestamps as `HH:MM:SS.mmm` (matching what the user's Gemini prompt expects: "Timestamp [TAB] Word/Phrase")
- Return as `text/tab-separated-values` with `Content-Disposition: attachment; filename="transcription.tsv"`

#### 5b. `POST /api/project/:sessionId/corrected-transcript`
- Accept the uploaded corrected `.tsv` file (multipart or raw text body)
- Parse TSV: each line → `{timestamp}\t{word}` → back to `TranscriptWord[]`
  - Parse `HH:MM:SS.mmm` back to `startMs`
  - Compute `endMs` from next word's `startMs` (last word keeps its original `endMs`)
- Update the session's transcript and regenerate captions
- Respond with `{ success: true }`

#### 5c. `POST /api/project/:sessionId/viral-clips`
- Accept JSON body: `{ text: string }` (the raw text pasted from Gemini)
- Parse the text to extract viral clips. Expected format (defined by the prompt we craft — see Step 7):
  ```
  CLIP 1
  Title: ...
  Hook: ...
  Start: HH:MM:SS.mmm
  End: HH:MM:SS.mmm

  CLIP 2
  ...
  ```
- Convert to `ViralClip[]` (parse timestamps to `startMs`/`endMs` in milliseconds)
- Store via `orchestrator.setViralClips(sessionId, clips)`
- Transition to `READY`
- Regenerate captions from the (possibly corrected) transcript
- Respond with `{ success: true, clips: ViralClip[] }`

---

### Step 6: New Client UI for the ALIGNING state

**File:** `client/src/components/PipelineStepper.tsx` (extend) or new component `client/src/components/AlignStep.tsx`

When `currentState === "ALIGNING"` and `progress === 100`, show the manual workflow UI:

#### Section A: "1. Download Transcript"
- A **"Download TSV"** button that fetches `GET /api/project/{sessionId}/transcript.tsv` and triggers browser download.

#### Section B: "2. Correct Transcript with Gemini"
- Display the correction prompt text (hardcoded from `transcription-correction.md`) in a read-only box.
- A **"Copy Prompt"** button that copies the prompt to clipboard using `navigator.clipboard.writeText()`.
- Instructions: "Upload the TSV and your original script (markdown) to Gemini, then paste the prompt above."

#### Section C: "3. Upload Corrected Transcript"
- A **file upload input** (accept `.tsv`) or a **textarea** where the user can paste the corrected TSV.
- On upload/paste, POST to `/api/project/{sessionId}/corrected-transcript`.
- Show success/error feedback.

#### Section D: "4. Find Viral Clips with Gemini"
- A **"Copy Prompt"** button for the viral analysis prompt (see Step 7).
- Instructions: "Paste this as your next message in the same Gemini chat."

#### Section E: "5. Paste Viral Clips"
- A **textarea** where the user pastes Gemini's viral clip output.
- A **"Next"** button that POSTs to `/api/project/{sessionId}/viral-clips` and transitions to READY.

#### Props needed:
- `sessionId: string` (to make API calls)
- Pass `sessionId` down from App.tsx through PipelineStepper

---

### Step 7: Craft the Viral Clip Detection Prompt

Create a well-structured prompt that:
- References the corrected transcript already in the Gemini chat context
- Asks for 3-5 viral segments (30-60 seconds each)
- Specifies the exact output format with timestamps:

```
Based on the corrected transcript above, identify 3-5 segments (30-60 seconds each) that would make the most viral short-form video clips. Look for:
- Strong emotional hooks or controversial statements
- Self-contained stories or arguments
- Surprising facts or revelations
- Moments with high energy or passion

For each clip, provide the output in EXACTLY this format:

CLIP 1
Title: [Short catchy title for the clip]
Hook: [The opening hook text that grabs attention]
Start: [Timestamp of the first word, copied exactly from the TSV]
End: [Timestamp of the last word, copied exactly from the TSV]

CLIP 2
Title: ...
Hook: ...
Start: ...
End: ...

IMPORTANT: Use the exact timestamps from the TSV file. Do not approximate.
```

---

### Step 8: Delete Unused Server Code

#### Delete files:
- `server/src/services/AlignmentService.ts` — Needleman-Wunsch is no longer used
- `server/src/services/LlmService.ts` — node-llama-cpp is no longer used

#### Delete server route:
- `server/src/routes/script.ts` — no longer needed (script was for alignment)

#### Remove registrations:
- In `server/src/index.ts`, remove the import and registration of `scriptRoute`
- Remove import of `AlignmentService` and `LlmService` from `transcribe.ts`

#### Remove dependency (optional, can defer):
- `node-llama-cpp` from `package.json` — the LLM model is no longer used

#### Remove from Orchestrator:
- `setSourceScript()` method and `sourceScript` field handling (or keep field in type but stop using it)

---

### Step 9: Update App.tsx for the New Flow

**File:** `client/src/App.tsx`

- Pass `sessionId` to `PipelineStepper` so the align step UI can make API calls
- Update `PipelineStepperProps` to include `sessionId`
- The `handleTranscribe` callback no longer takes `sourceScript`
- When READY is reached after the align step, the existing `useEffect` that fetches project data and auto-navigates to studio should still work as-is (it reads `viralClips` from the project state)

---

## File Change Summary

| File | Action |
|------|--------|
| `shared/types.ts` | Remove `ANALYZING` from `PipelineState` |
| `server/src/services/Orchestrator.ts` | Update transitions: `ALIGNING → READY`, remove `ANALYZING` |
| `server/src/routes/transcribe.ts` | Simplify: transcribe → ALIGNING and stop |
| `server/src/routes/project.ts` (or new `align.ts`) | Add 3 new endpoints: download TSV, upload corrected TSV, submit viral clips |
| `server/src/index.ts` | Register new routes, remove `scriptRoute` |
| `server/src/services/AlignmentService.ts` | **DELETE** |
| `server/src/services/LlmService.ts` | **DELETE** |
| `server/src/routes/script.ts` | **DELETE** |
| `client/src/components/PipelineStepper.tsx` | Remove script textarea, add align step UI with download/upload/copy/paste |
| `client/src/App.tsx` | Pass `sessionId` to PipelineStepper, simplify `handleTranscribe` |
| `client/src/components/PipelineStepper.css` | Add styles for the new align step UI |

## Notes for the Implementer

- The TSV timestamp format should be `HH:MM:SS.mmm` (e.g., `00:01:23.456`) — this matches what a human would expect and what Gemini can work with.
- The correction prompt is already written at `/Users/atti/Desktop/transcription-correction.md` — hardcode its content in the client component.
- The `endMs` for words in the corrected TSV can be computed as `next word's startMs` (since the original TSV only has start timestamps per word). The last word's `endMs` should use the original transcript's last word `endMs`.
- The "Copy to clipboard" buttons should show brief feedback ("Copied!") using a small state toggle.
- Keep the existing `ViralClip` interface (`title`, `hookText`, `startMs`, `endMs`) — the viral clip parsing on the server just needs to convert the text format to this structure.
- The `PipelineStepper` component will grow significantly. Consider extracting the align step UI into a separate `AlignStep.tsx` component for clarity.
