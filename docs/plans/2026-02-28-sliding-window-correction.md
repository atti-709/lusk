# Sliding Window Correction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `correctTranscript()` to use a 500-line sliding window with 50-line overlap and strict row validation.

**Architecture:** Extract chunking + validation into pure functions. Keep LLM call loop in `correctTranscript()`. Test the pure functions with vitest.

**Tech Stack:** TypeScript, vitest, `@google/genai`

---

### Task 1: Extract chunking logic into a testable pure function

**Files:**
- Modify: `server/src/services/GeminiService.ts:18-20` (constants) and `:93-156` (correctTranscript method)

**Step 1: Write the failing test**

Create `server/src/__tests__/GeminiChunking.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSlidingWindowChunks } from "../services/GeminiService.js";

describe("buildSlidingWindowChunks", () => {
  const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line${i}`);

  it("returns a single chunk when lines fit within CHUNK_SIZE", () => {
    const lines = makeLines(200);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 200, isFirst: true });
  });

  it("returns exactly one chunk when lines equal CHUNK_SIZE", () => {
    const lines = makeLines(500);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
  });

  it("produces overlapping windows for 950 lines", () => {
    const lines = makeLines(950);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
    expect(chunks[1]).toEqual({ startIndex: 450, endIndex: 950, isFirst: false });
  });

  it("produces correct windows for 1400 lines", () => {
    const lines = makeLines(1400);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
    expect(chunks[1]).toEqual({ startIndex: 450, endIndex: 950, isFirst: false });
    expect(chunks[2]).toEqual({ startIndex: 900, endIndex: 1400, isFirst: false });
  });

  it("merges a tiny tail into the previous chunk", () => {
    // 520 lines: chunk 0 would be [0,500), chunk 1 would be [450,520) = 70 lines sent
    // But the NEW portion is only 20 lines (500-520), which is < OVERLAP=50
    // so merge into previous: single chunk [0,520)
    const lines = makeLines(520);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 520, isFirst: true });
  });

  it("does NOT merge when tail has enough new lines", () => {
    // 600 lines: chunk 0 [0,500), chunk 1 [450,600) — 100 new lines, well above overlap
    const lines = makeLines(600);
    const chunks = buildSlidingWindowChunks(lines, 500, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 500, isFirst: true });
    expect(chunks[1]).toEqual({ startIndex: 450, endIndex: 600, isFirst: false });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/GeminiChunking.test.ts`
Expected: FAIL — `buildSlidingWindowChunks` is not exported from GeminiService

**Step 3: Implement `buildSlidingWindowChunks`**

In `server/src/services/GeminiService.ts`, update constants (lines 18-20) and add the function before the class:

```typescript
const MODEL = "gemini-3.1-pro-preview";
const CHUNK_SIZE = 500;   // lines per API call
const OVERLAP = 50;       // lines of overlap from previous chunk

// ...existing types and helpers...

export interface ChunkWindow {
  startIndex: number;  // inclusive
  endIndex: number;    // exclusive
  isFirst: boolean;
}

export function buildSlidingWindowChunks(
  lines: string[],
  chunkSize: number = CHUNK_SIZE,
  overlap: number = OVERLAP,
): ChunkWindow[] {
  if (lines.length <= chunkSize) {
    return [{ startIndex: 0, endIndex: lines.length, isFirst: true }];
  }

  const stride = chunkSize - overlap;
  const chunks: ChunkWindow[] = [];

  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + chunkSize, lines.length);
    chunks.push({ startIndex: start, endIndex: end, isFirst: start === 0 });
    if (end === lines.length) break;
  }

  // Merge tiny tail: if the last chunk's NEW portion (beyond previous chunk's coverage)
  // is smaller than the overlap, absorb it into the previous chunk
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    const newLines = last.endIndex - prev.endIndex;
    if (newLines < overlap) {
      chunks.pop();
      chunks[chunks.length - 1] = {
        ...prev,
        endIndex: last.endIndex,
      };
    }
  }

  return chunks;
}
```

Also remove the old `MIN_CHUNK_SIZE` constant (line 20).

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/GeminiChunking.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add server/src/__tests__/GeminiChunking.test.ts server/src/services/GeminiService.ts
git commit -m "feat: add buildSlidingWindowChunks with tests"
```

---

### Task 2: Add row validation helper with tests

**Files:**
- Modify: `server/src/services/GeminiService.ts` (add validation function)
- Modify: `server/src/__tests__/GeminiChunking.test.ts` (add validation tests)

**Step 1: Write the failing test**

Append to `server/src/__tests__/GeminiChunking.test.ts`:

```typescript
import { buildSlidingWindowChunks, validateChunkRowCount } from "../services/GeminiService.js";

describe("validateChunkRowCount", () => {
  it("does nothing when counts match", () => {
    expect(() => validateChunkRowCount(500, 500, 0, 5, "00:00:00.000", "00:05:00.000")).not.toThrow();
  });

  it("throws when counts differ", () => {
    expect(() => validateChunkRowCount(498, 500, 2, 5, "00:03:45.123", "00:07:52.456")).toThrow(
      /Chunk validation failed: chunk 3\/5, expected 500 lines, got 498/,
    );
  });

  it("includes timestamp range in error", () => {
    expect(() => validateChunkRowCount(501, 500, 1, 3, "00:01:00.000", "00:03:00.000")).toThrow(
      /00:01:00.000.*00:03:00.000/,
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/GeminiChunking.test.ts`
Expected: FAIL — `validateChunkRowCount` not exported

**Step 3: Implement `validateChunkRowCount`**

Add to `server/src/services/GeminiService.ts`, after `buildSlidingWindowChunks`:

```typescript
export function validateChunkRowCount(
  actual: number,
  expected: number,
  chunkIndex: number,
  totalChunks: number,
  startTimestamp: string,
  endTimestamp: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `Chunk validation failed: chunk ${chunkIndex + 1}/${totalChunks}, ` +
      `expected ${expected} lines, got ${actual}. ` +
      `Timestamp range: ${startTimestamp} – ${endTimestamp}. ` +
      `Pipeline halted. Investigate this segment manually.`,
    );
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/GeminiChunking.test.ts`
Expected: PASS (all 9 tests)

**Step 5: Commit**

```bash
git add server/src/__tests__/GeminiChunking.test.ts server/src/services/GeminiService.ts
git commit -m "feat: add validateChunkRowCount with tests"
```

---

### Task 3: Rewrite `correctTranscript()` to use sliding window + validation

**Files:**
- Modify: `server/src/services/GeminiService.ts:93-156` (replace correctTranscript method)

**Step 1: Replace `correctTranscript` method**

Replace the entire method body (lines 93–156) with:

```typescript
  async correctTranscript(
    words: TranscriptWord[],
    scriptText: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    const ai = await this.getClient();
    const prompt = await this.getCorrectionPrompt();
    const fullTsv = wordsToTsv(words);
    const lines = fullTsv.split("\n");
    const totalInputLines = lines.length;

    const chunks = buildSlidingWindowChunks(lines);
    const correctedLines: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error("Cancelled");

      const chunk = chunks[i];
      const chunkLabel = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : "";
      onProgress(
        Math.round((i / chunks.length) * 80),
        `Correcting transcript with Gemini${chunkLabel}...`,
      );

      const chunkLines = lines.slice(chunk.startIndex, chunk.endIndex);
      const chunkTsv = chunkLines.join("\n");

      const userMessage = [
        prompt,
        "",
        "## Reference Script (.md):",
        "",
        scriptText,
        "",
        "## Raw Transcription (.tsv):",
        "",
        chunkTsv,
      ].join("\n");

      let response;
      try {
        response = await ai.models.generateContent({
          model: MODEL,
          contents: userMessage,
        });
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        console.error(`[GeminiService] Error during transcript correction chunk ${i}:`, errObj.message);
        console.error(`[GeminiService] Request payload sample:`, userMessage.substring(0, 500) + "...");
        throw errObj;
      }

      const text = response.text ?? "";
      const resultLines = extractCodeBlock(text).split("\n").filter((l) => l.trim());

      // Validate: LLM must return exactly as many lines as we sent
      const startTs = chunkLines[0]?.split("\t")[0] ?? "?";
      const endTs = chunkLines[chunkLines.length - 1]?.split("\t")[0] ?? "?";
      validateChunkRowCount(resultLines.length, chunkLines.length, i, chunks.length, startTs, endTs);

      if (chunk.isFirst) {
        // First chunk: keep all lines
        correctedLines.push(...resultLines);
      } else {
        // Subsequent chunks: discard the overlap lines, keep only new lines
        const overlap = chunk.startIndex - chunks[i - 1].startIndex - (chunks[i - 1].endIndex - chunks[i - 1].startIndex) + OVERLAP;
        // Simpler: overlap is always OVERLAP lines for non-first chunks
        correctedLines.push(...resultLines.slice(OVERLAP));
      }
    }

    // Final validation: total output must match total input
    if (correctedLines.length !== totalInputLines) {
      throw new Error(
        `Final validation failed: input had ${totalInputLines} lines, ` +
        `but corrected output has ${correctedLines.length} lines. ` +
        `Pipeline halted.`,
      );
    }

    return correctedLines.join("\n");
  }
```

**Step 2: Verify the server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 3: Run all existing tests**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add server/src/services/GeminiService.ts
git commit -m "refactor: rewrite correctTranscript to use sliding window chunking with row validation"
```

---

### Task 4: Verify full test suite and build

**Step 1: Run all server tests**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 2: Run TypeScript compilation**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 3: Verify client still builds**

Run: `cd /Users/atti/Source/Repos/lusk && npm run build --workspace=client 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit (if any fixes were needed)**

Only if corrections were required in previous steps.
