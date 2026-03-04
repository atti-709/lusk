# **Project Context: Lusk (Local Node.js Server)**

## **Project Overview**

**Lusk** is a Local-First Web Application to create viral vertical shorts from Slovak video podcasts.

**Architecture:** Standard **Client-Server Architecture** running entirely on localhost.

* **Frontend:** React (Vite) running in the user's browser.  
* **Backend:** Node.js server running on the user's machine (doing the heavy AI/Video work).  
* **Target Hardware:** Apple Silicon (M1/M2/M3) using Metal acceleration.

## **File Structure & Lifecycle**

* **Root:** Lusk/
* **Temp Storage:** Lusk/server/.lusk_temp/{sessionId}/
  * This folder holds the uploaded input.mp4, the transcript.json, and the rendered output.mp4.
* **Session Persistence:**
  * On startup the server **restores** existing sessions from disk so in-progress work survives restarts.
  * Files persist during the session to allow for page reloads or crashes without data loss.
  * Old sessions can be deleted via `DELETE /api/sessions/{sessionId}`.

## **Tech Stack**

* **Server:** Node.js + Fastify + TypeScript.
* **Client:** React + Vite + TypeScript.
* **AI:** WhisperX (Python, via `pip install whisperx`) for transcription and forced word alignment.
* **Video:** Remotion (Player & Renderer).

## **Feature Implementation Details**

### **1. File Handling (Uploads)**

* **Flow:** User drags video to Browser -> Browser uploads to http://localhost:3000/api/upload -> Server saves to .lusk_temp/{sessionId}/input.mp4.
* **Access:** Server statically serves .lusk_temp so the frontend Player can access the video via URL (e.g., /static/{sessionId}/input.mp4).

### **2. Transcription (Server Side)**

* **Tool:** WhisperX (`python3 -m whisperx`), called from `WhisperService.ts`.
* **Model:** `large-v3-turbo`, language `sk`, compute type `int8`.
* **Flow:** Server extracts audio to `audio.wav` (16kHz mono via ffmpeg), then runs WhisperX which performs transcription and forced word-level alignment in a single pass using wav2vec2.
* **Output:** Per-word `start`/`end` timestamps in seconds. Words with missing alignment are interpolated linearly between their neighbours.
* **First-run model download:** WhisperX automatically downloads its models (~3-4 GB: `large-v3-turbo` + Slovak wav2vec2 alignment model) on first use.
* **Note:** `server/whisper.cpp/` and `server/scripts/whisperx_align.py` are legacy artifacts — they are not used.

### **3. Viral Clip Detection (Server Side)**

* **Status:** The LLM service has been removed. Viral clip suggestions are no longer generated automatically; clips are added manually by the user via the UI.
* **Legacy:** `server/models/meta-llama-3-8b-instruct.Q4_K_M.gguf` is a leftover and is not loaded.

### **4. Text Correction (Server Side)**

* **Algorithm:** **Needleman-Wunsch** (Global Alignment).
* **Location:** /server/src/services/AlignmentService.ts.
* **Task:** Run alignment on the server immediately after transcription if a script is provided.
* **Fuzzy Logic:** Normalize text (strip diacritics) before aligning to handle "Script vs Spoken" differences.

### **5. Caption Rendering (Client Side)**

* **Library:** @remotion/captions.
* **Data Flow:** Client fetches GET /api/project/transcript (which contains the aligned, corrected data).
* **Component:** Passes this data to createTikTokStyleCaptions.

### **6. Export (Server Side)**

* **Engine:** @remotion/renderer via `RenderService` (`/server/src/services/RenderService.ts`).
* **Bundling:** `@remotion/bundler` bundles `client/src/remotion/index.ts` once (cached in memory after first render). The `publicDir` is set to `client/public/` so static assets (outro, etc.) are included.
* **Rendering:** `renderMedia()` with `selectComposition()` to set per-clip duration and inputProps.
* **Hardware Acceleration:** `hardwareAcceleration: 'if-possible'`, `videoBitrate: '6000k'`, codec `h264`. On Apple Silicon this uses VideoToolbox automatically.
* **Delivery:** Server renders to `.lusk_temp/{sessionId}/output_{startMs}-{endMs}.mp4` and sets the download URL via orchestrator.

### **7. Outro (Client + Server)**

* **Asset:** Place `client/public/outro.mp4` (9:16 vertical video) to enable the outro feature.
* **Detection:** `RenderService.detectOutroConfig()` probes `client/public/outro.mp4` with ffprobe to get its duration in frames. Returns `null` if the file is absent (outro is silently skipped).
* **Client Preview:** `useOutroConfig` hook (`client/src/hooks/useOutroConfig.ts`) fetches `GET /api/outro-config` on mount and injects the outro props into the Remotion Player in `StudioView`. The preview shows the full clip + outro before export.
* **Composition:** A single `VideoComposition` handles both clip and outro via Remotion `Sequence` layering. `OUTRO_OVERLAP_FRAMES = 4` (defined in `VideoComposition.tsx`) controls how many frames the outro overlaps the end of the main clip. Total composition duration = `clipDuration + outroDuration - OUTRO_OVERLAP_FRAMES`.
* **Remotion Studio:** Run `cd client && npm run studio` to open the Remotion Studio for visual inspection. The default `videoUrl` prop is empty (renders black + outro); set it to `http://localhost:3000/static/{sessionId}/input.mp4` in the props panel to preview with a real video.

## **Setup (New Machine)**

### Prerequisites

Install these once via Homebrew:

```bash
brew install node ffmpeg
```

Install WhisperX via pip (requires Python 3):

```bash
pip3 install whisperx
```

> WhisperX downloads its models (~3-4 GB: `large-v3-turbo` + Slovak wav2vec2 alignment model) automatically on the first transcription run.

### Install & Run

```bash
# From the repo root:
npm install          # installs all workspaces (server, client, shared)
npm run dev          # starts server (port 3000) + client (port 5173) concurrently
```

### Runtime Dependencies Summary

| Dependency | Purpose | How to get |
|---|---|---|
| Node.js ≥ 20 | Server + client build | `brew install node` |
| ffmpeg | Audio extraction, video probing | `brew install ffmpeg` |
| Python 3 + WhisperX | Transcription + word alignment | `pip3 install whisperx` |

## **Distribution (Electron)**

### Packaging

* **Tool:** electron-builder (`electron/electron-builder.json`).
* **Targets:** macOS DMG + ZIP (arm64). ZIP is required for auto-updates.
* **Code signing:** Disabled (`"identity": null`) — no Apple Developer account.
* **Entry point:** `electron/src/main.ts` → compiled to `electron/dist/main.js`.
* **Bundle script:** `electron/scripts/bundle.ts` assembles server dist, client dist/src/public, shared types, and production `node_modules` into `electron/bundle/`.

### CI/CD (GitHub Actions)

* **Workflow:** `.github/workflows/release.yml`.
* **Trigger:** Every push to `main` (auto patch bump) or manual `workflow_dispatch` (choose patch/minor/major).
* **Versioning:** Derived from the latest `v*` git tag — `electron/package.json` version is overwritten at build time and not committed back. Tags are the source of truth.
* **Publishing:** `electron-builder --publish always` uploads DMG, ZIP, and `latest-mac.yml` to a GitHub Release. Uses `GITHUB_TOKEN` (automatic).
* **Note:** `electron-builder` is installed globally in CI to avoid `app-builder-bin` arm64 binary issues with npm workspace hoisting.

### Auto-Updater

* **Library:** `electron-updater` reads `latest-mac.yml` from GitHub Releases.
* **Behavior:** On app launch, checks for updates. If available, prompts user to download. Shows progress bar in the dock icon during download. After download, prompts to restart.
* **Menu:** "Check for Updates…" in the app menu triggers manual check.
* **Config:** `autoDownload: false`, `autoInstallOnAppQuit: true`.

### User Data Paths (macOS)

* **App data:** `~/Library/Application Support/Lusk/` — persists across installs/updates.
  * `config.json` — user settings (Gemini API key).
  * `recent-projects.json` — registry of recent projects (max 20, LRU).
  * `lusk_temp/{projectId}/` — session temp files (video symlinks, rendered clips).
* **Temp cleanup:** Orphaned temp directories (not in registry) are pruned on server startup. Deleting a project from the dashboard also deletes its temp folder.

### First Launch (Gatekeeper)

Since the app is unsigned, macOS blocks it. Users must run once:
```bash
xattr -cr /Applications/Lusk.app
```

## **User Instructions**

* When asking for code, specify if it belongs in the **/server** or **/client** directory.
* Ensure API types are shared between client and server (if using TypeScript).