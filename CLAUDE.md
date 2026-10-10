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

* **Tool:** `server/scripts/transcribe.py`, run in the managed Python env by `WhisperService.ts`.
* **Model:** `large-v3-turbo`, language from settings (default `sk`).
* **Flow:** Server extracts audio to `audio.wav` (16kHz mono via ffmpeg). The script transcribes with **mlx-whisper on the Apple GPU** (Metal; ~6× faster than WhisperX's CPU-only faster-whisper), then runs **WhisperX's wav2vec2 forced alignment** for per-word timings. Without MLX it falls back to WhisperX's own transcriber. Output is WhisperX's JSON shape.
* **Speech only:** MLX decodes only what WhisperX's pyannote VAD marks as speech (turns joined up to 30 s across ≤2 s pauses, each chunk decoded from its own audio slice — mlx-whisper's `clip_timestamps` never seeks to a clip's start and decoded the music between clips). Fed whole windows, Whisper invented "Ďakujem za pozornosť." over music, silence and the outro sting, and skipped the speech after a music bed (15-27 s lost in E08, E42, E47, E66, E67). Segments mostly outside the decoded audio (Whisper "hears" words in its silence padding) and stock sign-offs are dropped; speech no segment covers (≥1 s) is decoded again on its own.
* **Output:** Per-word `start`/`end` timestamps in seconds. Words with missing alignment are interpolated linearly between their neighbours.
* **First-run model download:** the MLX model (`mlx-community/whisper-large-v3-turbo`, ~1.6 GB) and the Slovak wav2vec2 alignment model download on first use into `~/.cache/huggingface`.
* **Note:** `server/whisper.cpp/` is a legacy artifact — it is not used.

### **3. Viral Clip Detection (Server Side)**

* **Tool:** Gemini via `GeminiService.ts` (`/server/src/services/GeminiService.ts`), model `gemini-3.8-flash` (`REASONING_MODEL`).
* **Flow:** After transcription/correction/proofreading, Gemini analyzes the transcript and suggests 12-16 viral clip candidates as **structured JSON** (`responseJsonSchema`, see `CLIP_SCHEMA`) — no text parsing. Timestamps are snapped onto real word starts by `geminiClipsToViralClips` (`routes/align.ts`).
* **Scores:** each clip carries 1-100 `hook`/`flow`/`value`/`reach` sub-scores, a hook-weighted composite `viralityScore` (`shared/types.ts`, OpusClip-style) and a one-sentence `scoreReason`. The clip grid sorts best-first by default.
* **Single-cut only:** every clip is one contiguous range (`startMs`/`endMs`). There is no multi-cut/concatenation — clips play straight through from the source. The clip's effective render range applies user trim deltas via `getClipRange` (`shared/types.ts`); `getClipRenderKey` derives the `${startMs}-${endMs}` output filename key from it.
* **Prompt:** `client/public/prompts/viral-clips-api.md` — instructs Gemini to find 20-30 second single-cut clips optimized for Instagram Reels, cutting **only at sentence boundaries** (start and end must be whole sentences; never mid-sentence), and defines the scoring rubric.
* **Manual workflow:** `viral-clips-manual.md` output is pasted back as text and parsed by `parseViralClipText` (no scores).
* **Users can also add clips manually** via the UI. Studio edits to a clip (trim, captions, framing) are saved with `PUT /api/projects/:id/clips`.
* **Legacy:** `server/models/meta-llama-3-8b-instruct.Q4_K_M.gguf` is a leftover from the previous offline LLM approach and is not loaded.

### **4. Text Correction (Server Side)**

* **Script correction:** with a reference script, `GeminiService.correctTranscript` rewrites the transcript row-for-row in 250-row TSV chunks (`gemini-3.5-flash-lite`, prompt `correction-api.md`).
* **Mapping rows back:** Gemini's rows are aligned to the heard words by content, never by index (`services/alignCorrection.ts`): with the script in view it inserts unspoken script words and drops others, which taken by index shifted every row between them onto a neighbour's time. A row similar to its heard word takes the correction; one that swaps in an unrelated word keeps the spoken word (the proofread pass, which also sees the script, fixes real mishearings); script insertions are dropped and a row Gemini split in two is joined back.
* **Proofread pass:** always runs next (`GeminiService.proofreadTranscript` + `services/proofread.ts`, prompt `proofread-api.md`). Gemini reads numbered sentences and returns only **sparse edits** `{line, find, replace}`; an edit is applied only if `find` matches that line verbatim and isn't a rewrite, and new words are timed inside the span they replace. This catches what the row-for-row pass misses (mishearings, run-together words, dropped "sa", stray punctuation, capitals). Failures are non-fatal.
* **Legacy:** `/server/src/services/AlignmentService.ts` (Needleman-Wunsch) no longer exists; alignment is Gemini-based.

### **5. Caption Rendering (Client Side)**

* **Library:** @remotion/captions.
* **Data Flow:** Client fetches GET /api/project/transcript (which contains the aligned, corrected data).
* **Component:** Passes this data to createTikTokStyleCaptions.

### **6. Export (Server Side)**

* **Engine:** @remotion/renderer via `RenderService` (`/server/src/services/RenderService.ts`).
* **Bundling:** `@remotion/bundler` bundles `client/src/remotion/index.ts` once (cached in memory after first render). The `publicDir` is set to `client/public/` so static assets (outro, etc.) are included.
* **Rendering:** `renderMedia()` with `selectComposition()` to set per-clip duration and inputProps. Output goes to `output_{key}.mp4.partial.mp4` and is renamed on success, so a cancelled render never leaves a truncated file.
* **Frame source:** `OffthreadVideo`. `@remotion/media`'s `<Video>` (WebCodecs) was measured on a 25 s E67 clip and rendered no faster (~19 s either way): the source is already cut into a short local H.264 segment first (`cutSourceSegment`), which removes the per-frame extraction cost `<Video>` would save.
* **Frame rate:** the FPS setting defaults to "Match source" (`MATCH_SOURCE_FPS` = 0): renders and the preview run at the source's own rate (`videoFps`, probed with width/height and filled in when an older project is opened), resolved by `resolveFps` (`shared/types.ts`). `composition.fps` is overridden per render; the outro is configured in seconds and converted at that rate. A 25 fps master rendered at the old fixed 23.976 dropped a frame every second.
* **Source strip:** frame extraction from the source dominates render time (a 4K master: ~50 s per 25 s clip whatever the `concurrency` — 4 to 12 measured the same). A landscape segment is cut down to the strip the crop can show over the clip (`services/sourceStrip.ts`: the clamped crop centers ± half the window) and the composition places it back inside the full-frame box (`sourceStrip` prop) — identical picture, 2-2.7× faster. Not applied with `fit` ranges (the whole frame is shown) or when the strip would be ≥90% of the width.
* **Loudness:** every render is normalized to -14 LUFS, true peak under -1.5 dBFS (`services/loudness.ts`: two-pass loudnorm, video copied, then a limiter) — the platforms' speech level and the show's own shorts. Sources ranged from -33 LUFS (review mixes) to -12 with peaks at 0.
* **Hardware Acceleration:** `hardwareAcceleration: 'if-possible'`, `videoBitrate: '6000k'`, codec `h264`. On Apple Silicon this uses VideoToolbox automatically.
* **Delivery:** Server renders to `.lusk_temp/{sessionId}/output_{startMs}-{endMs}.mp4` and sets the download URL via orchestrator.

### **6b. Speaker Tracking / 9:16 Framing (Server + Client)**

* **Script:** `server/scripts/track_speaker.py` (ported from the sermon pipeline) — Apple Vision face detection via `pyobjc-framework-Vision`, a virtual-camera solver (holds still, pans with minimum-jerk), and hard cuts on camera changes.
* **Modes** (`FramingMode` in `shared/types.ts`): `speaker` (whoever talks, judged from mouth movement on voiced audio; cuts between people — default), `face` (biggest face), `pick` (person clicked in the Studio's full-frame view, `subjectX`), `manual` (the old fixed `speakerOffsetX` slider; clips that had an offset stay manual).
* **Service:** `FramingService.ts` runs the script for a clip range and caches the result in `{sessionDir}/framing/`. `POST /api/projects/:id/framing` serves the Studio preview; renders solve (or reuse) the framing server-side, so Render All tracks too.
* **Graphics shown whole:** stretches with no real face (≥1 s), or with 3+ lines of burned-in text the crop would cut (Bible verses beside the host — read with Vision text recognition at 2 Hz) or 2+ when it truncates one mid-word (a big chapter title), come back as `fit` ranges: the full frame at width over a blurred fill. A single line (chapter label, name tag) never triggers it (Vision's pieces of one line are joined back first); stretches under 2 s apart merge, so the crop never flashes up between them. When the speaker stays on screen beside the text, the range is `[start, end, x0, x1]` (`FitRange`): only the part of the width text and speaker need is fitted, so a numbered tip in the corner (E04, E14) doesn't shrink the whole short to a 1080x608 strip.
* **Composition:** `VideoComposition` takes `framing` keyframes (crop center as a fraction of source width over clip time) and converts them per frame to the horizontal offset. Only for sources wider than 9:16.

### **6c. Source Playability**

* Electron's Chromium plays delivery codecs in any common container (H.264 in `.mkv`, PCM in `.mov`). Editing codecs (ProRes, DNxHD) are not decodable — `PlayableVideo.ts` makes `input.mp4` an H.264 copy (VideoToolbox) for those instead of a symlink, stamped by source size/mtime so it's made once.
* A plain local copy of the source with a matching stamp (`isCopyOf`) is kept as `input.mp4` too. The episode batch downloads each Drive source once that way: read through the Drive symlink, Drive dropped the file from its cache between transcription and rendering and it was downloaded a second time (8-10 min per 4K episode).

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

## **Testing the Electron App (E2E)**

Claude has full testing control over the Electron app via Playwright (`electron/e2e/`). **Verify Electron-facing changes end-to-end in the real app, not just with unit tests** — and against the packaged build when the change touches binaries, paths or module resolution (see Bundle Pitfalls).

* **Run:** `npm run test:e2e` (builds, then runs against `electron/dist/main.js`) · `npm run test:e2e:packaged` (runs against `electron/out/mac-arm64/Lusk.app` — rebuild it first with `npm run package`; `LUSK_E2E_APP=/path/Lusk.app` overrides).
* **Isolation:** every launch gets a free port and a temp profile (`LUSK_USER_DATA_DIR`), so it never touches real projects and doesn't collide with whatever holds port 3000. `config.json` (Gemini key) and the Python env are reused from the real profile. Builds without these overrides are refused.
* **Harness:** `launchLusk()` in `electron/e2e/harness.ts` returns `{ app, window, api(), stubSaveDialog(), stubOpenDialog(), logs, close() }`. Native dialogs are stubbed in the main process. `app.evaluate()` gives main-process access.
* **Ad hoc:** write a throwaway script that imports the harness by absolute path, run it with `npx tsx` from `electron/`, and take `window.screenshot()` to inspect the UI visually.
* **Fixtures:** `sampleVideo()` (`electron/e2e/fixtures.ts`) generates a 5s synthetic clip via ffmpeg (no speech — use a real podcast clip to exercise transcription).
* **Main-process env overrides** (`electron/src/main.ts`): `LUSK_PORT` (preferred port, default 3000 — the app falls back to the next port free on both IPv4 and IPv6), `LUSK_USER_DATA_DIR`, `LUSK_PYTHON_ENV_DIR`, `LUSK_DISABLE_AUTO_UPDATE=1`.

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

* **App data:** `~/Library/Application Support/@lusk/electron/` (dev and packaged builds alike) — persists across installs/updates.
  * `config.json` — user settings (Gemini API key).
  * `recent-projects.json` — registry of recent projects (max 20, LRU).
  * `lusk_temp/{projectId}/` — session temp files (video symlinks, rendered clips).
* **Temp cleanup:** Orphaned temp directories (not in registry) are pruned on server startup. Deleting a project from the dashboard also deletes its temp folder.

### First Launch (Gatekeeper)

Since the app is unsigned, macOS blocks it. Users must run once:
```bash
xattr -cr /Applications/Lusk.app
```

### Bundle Pitfalls (Dev vs DMG differences)

The DMG build has a different runtime environment than `npm run dev`. Common issues:

* **No `ffprobe` in bundle:** `ffmpeg-static` only ships `ffmpeg`, not `ffprobe`. Any code that calls `ffprobe` must have an `ffmpeg -i` stderr-parsing fallback (see `probeVideoDurationMs` pattern). Remotion ships its own ffmpeg/ffprobe in `@remotion/compositor-darwin-arm64`.
* **macOS quarantine on binaries:** All native binaries in the bundle (`ffmpeg-static/ffmpeg`, `@remotion/compositor-darwin-arm64/{ffmpeg,ffprobe,remotion}`) must have quarantine attributes cleared in `electron/scripts/bundle.ts` via `xattr -dr com.apple.quarantine`.
* **No npm workspace symlinks:** The `@lusk/shared` workspace package isn't linked in the bundle. `bundle.ts` must copy `shared/` into `client/node_modules/@lusk/shared` so Remotion's webpack bundler can resolve it at render time.
* **Child processes:** long-running Python helpers run in their own process groups (`ChildProcesses.ts`) so cancel kills everything they started; the server stops all jobs on SIGTERM, and Electron spawns the server detached and signals its whole group on quit — otherwise quitting mid-job orphaned WhisperX / headless Chrome.
* **Fastify empty body rejection:** `POST` requests with `Content-Type: application/json` and no body cause a 400 error. Don't set the JSON content-type header on requests that send no body.

### Python Environment (Managed via uv)

* **Service:** `PythonEnvService.ts` manages a self-contained Python 3.11 venv with pinned dependencies (`server/requirements-whisperx.txt`: WhisperX, mlx-whisper, pyobjc Vision).
* **Updates:** a `requirements.sha256` stamp in the env dir records what was installed; `ensureUpToDate()` (called before transcription and tracking) runs an incremental `uv pip install` when the requirements file changed. Helper scripts live in `server/scripts/` and are copied into the bundle by `bundle.ts`.
* **Location:** `~/Library/Application Support/@lusk/electron/python-env/` (Electron) or `.python-env/` (dev).
* **Pins:** `torch`, `torchaudio`, and `whisperx` are pinned together — they must be compatible. `transformers` 5.x requires `torch >= 2.6` (CVE-2025-32434). WhisperX 3.8.x requires `torch ~= 2.8.0` and `numpy >= 2.1.0`.
* **Setup flow:** Electron shows a setup dialog on first launch that streams progress via SSE from `POST /api/python-env/setup`. The SSE endpoint uses `reply.hijack()` to prevent Fastify from interfering.
* **Verification:** `import whisperx` cold start takes ~5s (loads torch). The `isReady()` check uses a 30s timeout.

## **User Instructions**

* When asking for code, specify if it belongs in the **/server** or **/client** directory.
* Ensure API types are shared between client and server (if using TypeScript).