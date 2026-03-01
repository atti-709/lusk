# Sliding Window Chunking for Transcript Correction

## Problem

The current `GeminiService.correctTranscript()` uses non-overlapping 1000-line chunks. This drops grammatical context at chunk boundaries — Slovak noun cases and verb tenses can be mangled when the LLM doesn't see the surrounding sentences. There is also no row-count validation, so silent row merges/drops by the LLM go undetected and break video caption sync.

## Solution

Refactor `correctTranscript()` in `server/src/services/GeminiService.ts` to use a sliding window with overlap and strict row validation.

## Constants

```typescript
const CHUNK_SIZE = 500;  // lines per API call
const OVERLAP = 50;      // lines of overlap from previous chunk
```

## Sliding Window Logic

Slide through TSV lines producing overlapping windows:

- Chunk 0: lines `[0, 500)` — full result kept
- Chunk 1: lines `[450, 950)` — discard first 50 lines of result (overlap), keep rest
- Chunk 2: lines `[900, 1400)` — discard first 50, keep rest
- ...until EOF

Last chunk: if remaining lines after the last window start are fewer than `OVERLAP`, merge into the previous chunk (avoid tiny tail chunks).

## .md Reference Script

Send the full `.md` script with every chunk (unchanged from current behavior). No dynamic extraction.

## Result Stitching

- Chunk 0: append all returned lines to output
- Chunk N (N > 0): discard first `OVERLAP` lines from LLM response, append the rest

## Row Validation

### Per-chunk

After extracting the LLM's TSV response for each chunk:

1. Count lines returned by LLM
2. Compare to expected count (number of input lines sent in that chunk)
3. If mismatch: throw fatal error with chunk index, expected vs actual count, and start/end timestamps

### Final

After all chunks stitched: compare `output.length === input.length`. Throw if different.

## Error Format

```
Chunk validation failed: chunk 2/5, expected 500 lines, got 498.
Timestamp range: 00:03:45.123 – 00:07:52.456
Pipeline halted. Investigate this segment manually.
```

## Scope

### Changes
- `server/src/services/GeminiService.ts` — `correctTranscript()` method only

### No changes
- `correction-api.md` prompt
- `detectViralClips()` method
- API endpoints in `align.ts` / `transcribe.ts`
- `extractCodeBlock()` helper
- Frontend components
