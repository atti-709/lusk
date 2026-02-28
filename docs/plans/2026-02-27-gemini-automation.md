# Gemini API Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automate the transcript correction and viral clip detection steps by calling the Gemini API server-side, replacing the manual copy/paste workflow.

**Architecture:** New `GeminiService` on the server calls `gemini-2.5-pro` via `@google/genai` for transcript correction (using the existing `correction.md` prompt + user-provided script) and viral clip detection (using `viral-clips.md` prompt). The IDLE screen gets a second drop zone for the `.md` script. Settings UI + `~/.lusk/config.json` stores the API key. Falls back to manual AlignStep if no API key or no script.

**Tech Stack:** `@google/genai` (Google GenAI SDK), Fastify routes, React components

---

### Task 1: Add `scriptText` to shared types

**Files:**
- Modify: `shared/types.ts:75-89` (ProjectData interface)
- Modify: `shared/types.ts:92-100` (ProjectState interface — inherits from ProjectData, no change needed)

**Step 1: Add scriptText field to ProjectData**

In `shared/types.ts`, add `scriptText` to the `ProjectData` interface after `correctedTranscriptRaw`:

```typescript
// In ProjectData interface, after line 87 (correctedTranscriptRaw):
  scriptText?: string | null;
```

**Step 2: Rebuild shared types**

Run: `cd /Users/atti/Source/Repos/lusk && npm run build --workspace=shared 2>&1 || echo "no build script, skip"`

Expected: Types are updated (shared may not have a build step — that's fine, it's consumed directly).

**Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add scriptText field to ProjectData"
```

---

### Task 2: Add `setScriptText` to Orchestrator and persist it

**Files:**
- Modify: `server/src/services/Orchestrator.ts:92-102`
- Modify: `server/src/services/ProjectFileService.ts:339-352`

**Step 1: Add setScriptText method to Orchestrator**

In `server/src/services/Orchestrator.ts`, add after the `setCorrectedTranscriptRaw` method (line 102):

```typescript
  setScriptText(id: string, text: string | null): void {
    const session = this.requireSession(id);
    session.scriptText = text;
    this.persistSession(id);
  }
```

Note: `ProjectState` extends `ProjectData` which now has `scriptText`, so the field already exists on the session object.

**Step 2: Persist scriptText in ProjectFileService.saveProject**

In `server/src/services/ProjectFileService.ts`, in the `saveProject` method, add `scriptText` to the `data` object (around line 349, after `correctedTranscriptRaw`):

```typescript
      scriptText: session.scriptText ?? null,
```

**Step 3: Verify server compiles**

Run: `cd /Users/atti/Source/Repos/lusk/server && npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add server/src/services/Orchestrator.ts server/src/services/ProjectFileService.ts
git commit -m "feat: add scriptText to orchestrator and project persistence"
```

---

### Task 3: Add script upload route

**Files:**
- Modify: `server/src/routes/align.ts` (add route at end of `alignRoute` function)

**Step 1: Add POST route for script text**

In `server/src/routes/align.ts`, inside the `alignRoute` function (before the closing `}`), add:

```typescript
  // 5g. Upload reference script text
  app.post<{
    Params: { projectId: string };
    Body: { scriptText: string };
    Reply: { success: true } | ErrorResponse;
  }>(
    "/api/projects/:projectId/script",
    async (request, reply) => {
      const { projectId } = request.params;
      const session = orchestrator.getSession(projectId);

      if (!session) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      const { scriptText } = (request.body ?? {}) as Partial<{ scriptText: string }>;

      if (!scriptText || typeof scriptText !== "string") {
        return reply.status(400).send({ success: false, error: "scriptText is required" });
      }

      orchestrator.setScriptText(projectId, scriptText);
      return { success: true as const };
    }
  );
```

**Step 2: Verify server compiles**

Run: `cd /Users/atti/Source/Repos/lusk/server && npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add server/src/routes/align.ts
git commit -m "feat: add script text upload route"
```

---

### Task 4: Settings service and routes

**Files:**
- Create: `server/src/services/SettingsService.ts`
- Create: `server/src/routes/settings.ts`
- Modify: `server/src/index.ts:1-11` (add import) and `server/src/index.ts:38-39` (register route)

**Step 1: Create SettingsService**

Create `server/src/services/SettingsService.ts`:

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AppSettings {
  geminiApiKey?: string;
}

function getConfigPath(): string {
  return join(process.env.LUSK_REGISTRY_DIR ?? join(homedir(), ".lusk"), "config.json");
}

class SettingsService {
  private cache: AppSettings | null = null;

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(getConfigPath(), "utf-8");
      this.cache = JSON.parse(raw) as AppSettings;
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  async save(settings: AppSettings): Promise<void> {
    const configPath = getConfigPath();
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, JSON.stringify(settings, null, 2), "utf-8");
    this.cache = settings;
  }

  async getGeminiApiKey(): Promise<string | null> {
    // Env var takes precedence
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    const settings = await this.load();
    return settings.geminiApiKey ?? null;
  }
}

export const settingsService = new SettingsService();
```

**Step 2: Create settings routes**

Create `server/src/routes/settings.ts`:

```typescript
import type { FastifyPluginAsync } from "fastify";
import { settingsService } from "../services/SettingsService.js";

export const settingsRoute: FastifyPluginAsync = async (server) => {
  server.get("/api/settings", async () => {
    const settings = await settingsService.load();
    // Mask the API key for the client — only send whether it's configured
    return {
      geminiApiKeySet: !!(settings.geminiApiKey || process.env.GEMINI_API_KEY),
    };
  });

  server.put<{ Body: { geminiApiKey?: string } }>(
    "/api/settings",
    async (request) => {
      const current = await settingsService.load();
      const { geminiApiKey } = request.body ?? {};

      if (geminiApiKey !== undefined) {
        current.geminiApiKey = geminiApiKey;
      }

      await settingsService.save(current);
      return { success: true };
    }
  );
};
```

**Step 3: Register settings route in index.ts**

In `server/src/index.ts`, add the import after line 10:

```typescript
import { settingsRoute } from "./routes/settings.js";
```

And register it after line 39 (after `projectsRoute`):

```typescript
await server.register(settingsRoute);
```

**Step 4: Verify server compiles**

Run: `cd /Users/atti/Source/Repos/lusk/server && npx tsc --noEmit`

Expected: No errors.

**Step 5: Commit**

```bash
git add server/src/services/SettingsService.ts server/src/routes/settings.ts server/src/index.ts
git commit -m "feat: add settings service and routes for Gemini API key"
```

---

### Task 5: Install `@google/genai` and create GeminiService

**Files:**
- Modify: `server/package.json` (add dependency)
- Create: `server/src/services/GeminiService.ts`

**Step 1: Install @google/genai**

Run: `cd /Users/atti/Source/Repos/lusk && npm install @google/genai --workspace=server`

Expected: Package added to `server/package.json` dependencies.

**Step 2: Create GeminiService**

Create `server/src/services/GeminiService.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { settingsService } from "./SettingsService.js";

const MODEL = "gemini-2.5-pro";
const CHUNK_SIZE = 2000; // lines per chunk, matches existing download logic

type ProgressCallback = (percent: number, message: string) => void;

// ── Helpers ──

function msToTimestamp(ms: number): string {
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

function wordsToTsv(words: TranscriptWord[]): string {
  return words.map((w) => `${msToTimestamp(w.startMs)}\t${w.word}`).join("\n");
}

function extractCodeBlock(response: string): string {
  // Extract content from ```...``` code block
  const match = response.match(/```(?:tsv)?\s*\n([\s\S]*?)\n```/);
  if (match) return match[1].trim();
  // If no code block, assume the whole response is the TSV
  return response.trim();
}

// ── Service ──

class GeminiService {
  private correctionPromptCache: string | null = null;
  private viralClipPromptCache: string | null = null;

  private async getClient(): Promise<GoogleGenAI> {
    const apiKey = await settingsService.getGeminiApiKey();
    if (!apiKey) throw new Error("Gemini API key not configured");
    return new GoogleGenAI({ apiKey });
  }

  private async getCorrectionPrompt(): Promise<string> {
    if (this.correctionPromptCache) return this.correctionPromptCache;
    const promptPath = join(process.cwd(), "..", "client", "public", "prompts", "correction.md");
    this.correctionPromptCache = await readFile(promptPath, "utf-8");
    return this.correctionPromptCache;
  }

  private async getViralClipPrompt(): Promise<string> {
    if (this.viralClipPromptCache) return this.viralClipPromptCache;
    const promptPath = join(process.cwd(), "..", "client", "public", "prompts", "viral-clips.md");
    this.viralClipPromptCache = await readFile(promptPath, "utf-8");
    return this.viralClipPromptCache;
  }

  async isAvailable(): Promise<boolean> {
    const key = await settingsService.getGeminiApiKey();
    return !!key;
  }

  /**
   * Correct transcript using script as reference.
   * Returns the corrected TSV as a string.
   */
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

    // Chunk if needed
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      chunks.push(lines.slice(i, i + CHUNK_SIZE).join("\n"));
    }

    const correctedParts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error("Cancelled");

      const chunkLabel = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : "";
      onProgress(
        Math.round((i / chunks.length) * 80),
        `Correcting transcript with Gemini${chunkLabel}...`,
      );

      const userMessage = [
        prompt,
        "",
        "## Reference Script (.md):",
        "",
        scriptText,
        "",
        "## Raw Transcription (.tsv):",
        "",
        chunks[i],
      ].join("\n");

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
      });

      const text = response.text ?? "";
      correctedParts.push(extractCodeBlock(text));
    }

    return correctedParts.join("\n");
  }

  /**
   * Detect viral clips from corrected transcript.
   * Returns the raw clip text (CLIP 1\nTitle: ...) for parsing.
   */
  async detectViralClips(
    correctedTsv: string,
    onProgress: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error("Cancelled");

    onProgress(85, "Finding viral clips with Gemini...");

    const ai = await this.getClient();
    const prompt = await this.getViralClipPrompt();

    const userMessage = [
      prompt,
      "",
      "## Corrected Transcript (.tsv):",
      "",
      correctedTsv,
    ].join("\n");

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userMessage,
    });

    return response.text ?? "";
  }
}

export const geminiService = new GeminiService();
```

**Step 3: Verify server compiles**

Run: `cd /Users/atti/Source/Repos/lusk/server && npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add server/package.json package-lock.json server/src/services/GeminiService.ts
git commit -m "feat: add GeminiService for transcript correction and viral clip detection"
```

---

### Task 6: Auto-trigger Gemini after transcription

**Files:**
- Modify: `server/src/routes/transcribe.ts:17-35` (doTranscribe function)
- Modify: `server/src/routes/align.ts:44-66` (reuse parseViralClipText and parseTsv)

**Step 1: Export parseTsv, parseViralClipText, and wordsToCaptions from align.ts**

In `server/src/routes/align.ts`, add `export` keyword to these functions:

- `export function parseTsv(...)` (line 29)
- `export function parseViralClipText(...)` (line 45)
- `export function wordsToCaptions(...)` (line 68)

**Step 2: Modify doTranscribe to auto-run Gemini**

In `server/src/routes/transcribe.ts`, add these imports at the top:

```typescript
import { geminiService } from "../services/GeminiService.js";
import { parseTsv, parseViralClipText, wordsToCaptions } from "./align.js";
```

Then modify the `doTranscribe` function. After the existing `orchestrator.transition(sessionId, "ALIGNING");` line, add the auto-Gemini logic:

```typescript
export async function doTranscribe(sessionId: string, log: Logger, signal?: AbortSignal): Promise<void> {
  const sessionDir = tempManager.getSessionDir(sessionId);

  orchestrator.updateProgress(sessionId, 0, "Starting transcription...");

  const { transcript, captions } = await whisperService.transcribe(
    sessionDir,
    (percent, message) => {
      orchestrator.updateProgress(sessionId, percent, message);
    },
    signal,
  );

  orchestrator.setTranscript(sessionId, transcript);
  orchestrator.setCaptions(sessionId, captions);

  orchestrator.transition(sessionId, "ALIGNING");

  // Auto-run Gemini correction + viral clip detection if script and API key are available
  const session = orchestrator.getSession(sessionId);
  const hasScript = !!session?.scriptText;
  const geminiAvailable = await geminiService.isAvailable();

  if (hasScript && geminiAvailable && session) {
    try {
      orchestrator.updateProgress(sessionId, 5, "Starting Gemini correction...");

      // 1. Correct transcript
      const correctedTsv = await geminiService.correctTranscript(
        transcript.words,
        session.scriptText!,
        (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
        signal,
      );

      // Parse and apply corrected transcript
      const lastWord = transcript.words.at(-1);
      const fallbackEndMs = lastWord ? lastWord.endMs : 0;
      const correctedWords = parseTsv(correctedTsv, fallbackEndMs);
      const correctedTranscript = { text: "", words: correctedWords };

      orchestrator.setTranscript(sessionId, correctedTranscript);
      orchestrator.setCorrectedTranscriptRaw(sessionId, correctedTsv);
      orchestrator.setCaptions(sessionId, wordsToCaptions(correctedWords));

      // 2. Detect viral clips
      const viralClipText = await geminiService.detectViralClips(
        correctedTsv,
        (percent, message) => orchestrator.updateProgress(sessionId, percent, message),
        signal,
      );

      const clips = viralClipText.trim() ? parseViralClipText(viralClipText) : [];
      orchestrator.setViralClips(sessionId, clips);

      // Transition to READY
      orchestrator.transition(sessionId, "READY");
      orchestrator.updateProgress(sessionId, 100, "Ready to review");
    } catch (err: any) {
      if (signal?.aborted) throw err; // re-throw cancellation
      // Gemini failed — stay in ALIGNING for manual fallback
      log.error(err, "Gemini automation failed, falling back to manual");
      orchestrator.updateProgress(sessionId, 100, "Gemini failed — use manual workflow below");
    }
  } else {
    // No script or no API key — manual workflow
    orchestrator.updateProgress(sessionId, 100, "Transcript ready — download and correct with Gemini");
  }
}
```

**Step 3: Verify server compiles**

Run: `cd /Users/atti/Source/Repos/lusk/server && npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add server/src/routes/transcribe.ts server/src/routes/align.ts
git commit -m "feat: auto-trigger Gemini correction and viral clip detection after transcription"
```

---

### Task 7: Add script drop zone to IDLE screen

**Files:**
- Modify: `client/src/App.tsx:389-418` (IDLE state section)

**Step 1: Add script state and handlers**

In `client/src/App.tsx`, add state for the script near the other state declarations (around line 32):

```typescript
const [scriptText, setScriptText] = useState<string | null>(null);
const [scriptFileName, setScriptFileName] = useState<string | null>(null);
```

Add a handler to read and upload the script file (after `handleIdleDrop`, around line 245):

```typescript
  const handleScriptFile = useCallback(async (filePath: string) => {
    if (!sessionId) return;
    const fileName = filePath.split("/").pop() ?? filePath;
    try {
      // Read the file content via Electron
      const content = await window.lusk?.readFile?.(filePath);
      if (!content) {
        setIdleUploadError("Could not read script file");
        return;
      }
      // Upload to server
      const res = await fetch(`/api/projects/${sessionId}/script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptText: content }),
      });
      if (res.ok) {
        setScriptText(content);
        setScriptFileName(fileName);
      }
    } catch {
      setIdleUploadError("Failed to upload script");
    }
  }, [sessionId]);

  const handleScriptDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.lusk?.getFilePath?.(file) ?? "";
    if (filePath) {
      handleScriptFile(filePath);
    } else {
      // Browser fallback: read via FileReader
      const reader = new FileReader();
      reader.onload = async () => {
        const content = reader.result as string;
        if (!sessionId) return;
        const res = await fetch(`/api/projects/${sessionId}/script`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptText: content }),
        });
        if (res.ok) {
          setScriptText(content);
          setScriptFileName(file.name);
        }
      };
      reader.readAsText(file);
    }
  }, [sessionId, handleScriptFile]);

  const handleScriptBrowse = useCallback(async () => {
    const lusk = window.lusk;
    if (!lusk) return;
    const result = await lusk.showOpenDialog({
      title: "Select reference script",
      filters: [{ name: "Markdown", extensions: ["md", "txt"] }],
    });
    if (result.canceled || !result.filePath) return;
    handleScriptFile(result.filePath);
  }, [handleScriptFile]);
```

**Step 2: Modify the IDLE state JSX**

Replace the IDLE state block (lines 389-418) with a version that includes the script drop zone. The key change is adding a second section below the video drop zone:

```tsx
      {/* IDLE state: no video linked yet — show drop zone */}
      {view === "session" && state && state.state === "IDLE" && (
        <div className="pipeline-stage">
          <div
            className={`idle-notice idle-dropzone${idleDragOver ? " drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIdleDragOver(true); }}
            onDragLeave={() => setIdleDragOver(false)}
            onDrop={handleIdleDrop}
          >
            <div className="upload-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <h2>Add a source video</h2>
            <p>Drag & drop a video file here, or click to browse.</p>
            {state.videoName && (
              <p className="idle-filename-hint">
                Looking for: <code>{state.videoName}.mp4</code>
              </p>
            )}
            <button className="primary" onClick={handleIdleVideoSelect}>
              Browse files
            </button>
          </div>

          {/* Script drop zone */}
          <div
            className="idle-notice idle-dropzone script-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleScriptDrop}
          >
            <div className="upload-icon">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <h2>Add reference script <span className="optional-badge">optional</span></h2>
            {scriptFileName ? (
              <p className="script-loaded">{scriptFileName}</p>
            ) : (
              <p>Drag & drop a .md script for AI-powered transcript correction.</p>
            )}
            <button className="secondary" onClick={handleScriptBrowse}>
              Browse scripts
            </button>
          </div>

          {idleUploadError && (
            <p className="idle-error">{idleUploadError}</p>
          )}
        </div>
      )}
```

**Step 3: Add CSS for the script drop zone**

In `client/src/App.css`, add after the `.idle-filename-hint code` block (around line 195):

```css
.script-dropzone {
  margin-top: 0;
  border-style: dashed;
  border-width: 1px;
  padding: 1.5rem 2rem;
}

.optional-badge {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--surface);
  padding: 0.15em 0.5em;
  border-radius: 6px;
  vertical-align: middle;
  margin-left: 0.3em;
}

.script-loaded {
  color: var(--accent) !important;
  font-weight: 600;
}
```

**Step 4: Reset script state in resetSessionState**

In `client/src/App.tsx`, update the `resetSessionState` callback (around line 90):

```typescript
  const resetSessionState = useCallback(() => {
    setCaptions([]);
    setViralClips([]);
    setSelectedClip(null);
    setReadySubView("review");
    setScriptText(null);
    setScriptFileName(null);
  }, []);
```

**Step 5: Verify client compiles**

Run: `cd /Users/atti/Source/Repos/lusk/client && npx tsc --noEmit`

Expected: No errors (or only pre-existing warnings).

**Step 6: Commit**

```bash
git add client/src/App.tsx client/src/App.css
git commit -m "feat: add script drop zone to IDLE screen"
```

---

### Task 8: Add Electron `readFile` bridge (if needed)

**Files:**
- Check: `electron/` or preload scripts for existing file reading capability

**Step 1: Check if readFile exists on window.lusk**

Search for `readFile` in the Electron preload script. If it doesn't exist, we need to add it. If there is no Electron setup, the browser fallback in `handleScriptDrop` (FileReader) will work.

Run: `grep -r "readFile" /Users/atti/Source/Repos/lusk/electron/ 2>/dev/null || grep -r "readFile" /Users/atti/Source/Repos/lusk/client/src/ 2>/dev/null || echo "readFile not found"`

If `readFile` is not exposed via `window.lusk`, add it to the preload script:

```typescript
// In preload.ts (Electron):
readFile: (filePath: string) => ipcRenderer.invoke("read-file", filePath),
```

And in the main process:

```typescript
ipcMain.handle("read-file", async (_event, filePath: string) => {
  const { readFile } = await import("node:fs/promises");
  return readFile(filePath, "utf-8");
});
```

**If no Electron setup exists:** Skip this task — the browser FileReader fallback in the script drop handler already handles it. The `handleScriptFile` function (which uses `window.lusk?.readFile`) will silently fall through to the `else` branch.

**Step 2: Commit (if changes were made)**

```bash
git add electron/
git commit -m "feat: expose readFile in Electron preload for script loading"
```

---

### Task 9: Settings UI in header

**Files:**
- Create: `client/src/components/SettingsDialog.tsx`
- Modify: `client/src/App.tsx` (add gear icon + dialog)
- Modify: `client/src/App.css` (settings styles)

**Step 1: Create SettingsDialog component**

Create `client/src/components/SettingsDialog.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [isSet, setIsSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setIsSet(data.geminiApiKeySet);
        if (data.geminiApiKeySet) {
          setApiKey(""); // Don't show the actual key
        }
      })
      .catch(() => {});
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: apiKey }),
      });
      if (res.ok) {
        setIsSet(true);
        setStatus("Saved");
        setTimeout(() => setStatus(null), 2000);
      }
    } catch {
      setStatus("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="settings-field">
          <label htmlFor="gemini-key">Gemini API Key</label>
          <input
            id="gemini-key"
            type="password"
            placeholder={isSet ? "Key is set (enter new to replace)" : "Enter your Gemini API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="settings-hint">
            Get a key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>
          </p>
        </div>
        <div className="settings-actions">
          {status && <span className="settings-status">{status}</span>}
          <button className="secondary" onClick={onClose}>Close</button>
          <button className="primary" onClick={handleSave} disabled={saving || !apiKey.trim()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Add gear icon to App header**

In `client/src/App.tsx`, import the SettingsDialog:

```typescript
import { SettingsDialog } from "./components/SettingsDialog";
```

Add state:

```typescript
const [settingsOpen, setSettingsOpen] = useState(false);
```

Add the gear icon to the header (after the logo-container div, inside the header):

```tsx
<header className="app-header">
  <div
    className="logo-container"
    onClick={handleLogoClick}
    role="button"
    tabIndex={0}
    title="Go to Dashboard"
  >
    <div className="logo-mark"><Logo /></div>
    <h1>Lusk</h1>
  </div>
  <button
    className="settings-btn"
    onClick={() => setSettingsOpen(true)}
    title="Settings"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  </button>
</header>

<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
```

**Step 3: Add CSS for settings**

In `client/src/App.css`, add:

```css
/* ── Settings ── */
.settings-btn {
  position: absolute;
  right: 1.5rem;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0.4rem;
  border-radius: 8px;
  transition: color 0.2s, background 0.2s;
  -webkit-app-region: no-drag;
}

.settings-btn:hover {
  color: var(--text);
  background: var(--surface);
}

.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.settings-dialog {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 2rem;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.settings-dialog h2 {
  margin: 0 0 1.5rem;
  font-size: 1.1rem;
  font-weight: 700;
}

.settings-field {
  margin-bottom: 1.5rem;
}

.settings-field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--text);
}

.settings-field input {
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.85rem;
  box-sizing: border-box;
}

.settings-field input:focus {
  outline: none;
  border-color: var(--accent);
}

.settings-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 0.5rem 0 0;
}

.settings-hint a {
  color: var(--accent);
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  justify-content: flex-end;
}

.settings-status {
  font-size: 0.8rem;
  color: var(--accent);
  margin-right: auto;
}
```

**Step 4: Verify client compiles**

Run: `cd /Users/atti/Source/Repos/lusk/client && npx tsc --noEmit`

Expected: No errors.

**Step 5: Commit**

```bash
git add client/src/components/SettingsDialog.tsx client/src/App.tsx client/src/App.css
git commit -m "feat: add settings dialog with Gemini API key configuration"
```

---

### Task 10: Update PipelineStepper for automated progress

**Files:**
- Modify: `client/src/components/PipelineStepper.tsx:58-65`

**Step 1: Show progress during ALIGNING when < 100%**

The current code only shows the AlignStep when `progress === 100`. The progress bar is already shown when `isProcessing` is true. We just need to include ALIGNING in the processing check when its progress is < 100 (which it already does at line 59).

Actually, looking at the code again, line 59 already handles this:
```typescript
const isProcessing =
    (currentState === "TRANSCRIBING") ||
    (currentState === "ALIGNING" && progress < 100) ||
    (currentState === "RENDERING");
```

And `showAlignStep` at line 63 only shows when `progress === 100`. So the automated Gemini flow (which keeps progress < 100 during API calls) will naturally show the progress bar, and only show the manual AlignStep when Gemini finishes or fails (progress set to 100).

This means **no changes are needed** to PipelineStepper — the existing logic already handles both the automated and manual flows correctly.

**Step 2: Verify by reading the flow**

- Gemini running: `state=ALIGNING, progress=5-95` → `isProcessing=true`, progress bar shown
- Gemini done → transitions to READY → review screen shown
- Gemini failed: `state=ALIGNING, progress=100, message="Gemini failed..."` → `showAlignStep=true`, manual fallback shown
- No script/key: `state=ALIGNING, progress=100` → `showAlignStep=true`, manual workflow

No commit needed for this task.

---

### Task 11: Expose geminiApiKeySet in health endpoint

**Files:**
- Modify: `server/src/index.ts:41-44`

**Step 1: Add geminiApiKeySet to health response**

In `server/src/index.ts`, modify the health endpoint to include whether Gemini is available:

```typescript
import { settingsService } from "./services/SettingsService.js";
```

Then update the handler:

```typescript
server.get("/api/health", async () => {
  const whisperxAvailable = await whisperService.isAvailable();
  const geminiApiKeySet = !!(await settingsService.getGeminiApiKey());
  return { status: "ok" as const, uptime: process.uptime(), whisperxAvailable, geminiApiKeySet };
});
```

**Step 2: Update client to check Gemini availability**

In `client/src/App.tsx`, in the health check `useEffect` (line 42-49), add:

```typescript
const [geminiAvailable, setGeminiAvailable] = useState(false);
```

And in the health fetch handler:

```typescript
if (typeof data.geminiApiKeySet === "boolean") {
  setGeminiAvailable(data.geminiApiKeySet);
}
```

This state can be used later to show UI hints about whether the Gemini pipeline will run.

**Step 3: Commit**

```bash
git add server/src/index.ts client/src/App.tsx
git commit -m "feat: expose Gemini availability in health endpoint"
```

---

### Task 12: End-to-end manual test

**Step 1: Start the dev server**

Run: `cd /Users/atti/Source/Repos/lusk && npm run dev`

**Step 2: Test the settings flow**

1. Open http://localhost:5173
2. Click the gear icon in the header
3. Enter a Gemini API key
4. Click Save — should show "Saved" confirmation
5. Close and reopen — should show "Key is set"

**Step 3: Test with script (automated flow)**

1. Create a new project
2. Drop a video file on the video drop zone
3. Drop a `.md` script file on the script drop zone — should show the filename
4. Click "Start Transcription"
5. Watch the pipeline: Transcribing → Aligning (progress bar with Gemini messages) → Ready
6. Verify captions and viral clips are populated

**Step 4: Test without script (manual fallback)**

1. Create a new project
2. Drop a video file (no script)
3. Click "Start Transcription"
4. After transcription: should show the manual AlignStep workflow
5. Verify manual copy/paste flow still works

**Step 5: Commit final state**

```bash
git add -A
git commit -m "feat: complete Gemini API automation for transcript correction and viral clip detection"
```
