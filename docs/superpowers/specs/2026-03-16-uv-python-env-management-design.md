# UV-Based Python Environment Management

**Date:** 2026-03-16
**Status:** Draft

## Problem

WhisperX depends on Python, PyTorch, numpy, and pyannote — all of which have strict version interdependencies. Installing via global `pip3 install whisperx` breaks on other machines due to:
- numpy 2.x incompatibility with older C-extension packages (asteroid-filterbanks)
- PyTorch 2.6+ changing `torch.load` defaults (`weights_only=True` rejects omegaconf types)
- Python 3.14+ blocking global pip installs entirely

Users should not have to manage Python environments manually.

## Solution

Use [uv](https://github.com/astral-sh/uv) to manage a fully isolated Python 3.11 environment with pinned dependencies. The app downloads `uv` on first launch, creates a venv, and installs WhisperX with exact version pins — completely transparent to the user.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| When to set up | On app launch | Ensures readiness before user hits Transcribe |
| uv delivery | Downloaded at runtime | Keeps DMG smaller; internet required anyway for WhisperX models |
| Env location | `~/Library/Application Support/Lusk/python-env/` | Long-lived, persists across updates, consistent with other app data |
| Python version | 3.11.x | Best compatibility sweet spot for WhisperX + PyTorch + numpy |
| Progress UX | Native Electron modal dialog | Blocks interaction during setup, simple and clear |

## Architecture

```
App Launch
  -> Electron: GET /api/python-env/status
  -> { ready: false }
  -> Show modal dialog: "Setting up transcription engine..."
  -> Electron: GET /api/python-env/setup (SSE stream)
     -> Server: download uv binary -> {envDir}/uv
     -> Server: uv python install 3.11
     -> Server: uv venv --python 3.11
     -> Server: uv pip install -r requirements-whisperx.txt
     -> SSE progress events: { step, percent, message }
  -> Dialog closes on completion
  -> Normal app flow continues
```

## Components

### 1. PythonEnvService (Server)

**New file:** `server/src/services/PythonEnvService.ts`

**Responsibilities:**
- Download the `uv` standalone binary from GitHub releases to `{envDir}/uv`
- Run `uv python install 3.11` to fetch a standalone Python
- Run `uv venv {envDir}/venv --python 3.11` to create the venv
- Run `uv pip install --python {envDir}/venv/bin/python -r requirements-whisperx.txt` to install deps
- Expose `getPythonPath(): string` — returns `{envDir}/venv/bin/python`
- Expose `isReady(): boolean` — checks if venv exists and whisperx is importable
- Emit progress events via a callback during setup

**Environment directory structure:**
```
~/Library/Application Support/Lusk/python-env/
  uv              # uv binary
  venv/           # Python 3.11 venv
    bin/python
    lib/python3.11/site-packages/...
```

### 2. requirements-whisperx.txt (Server)

**New file:** `server/requirements-whisperx.txt`

Pins exact versions to avoid the numpy/torch compatibility issues:
```
torch==2.5.1
torchaudio==2.5.1
numpy<2
whisperx @ git+https://github.com/m-bain/whisperX.git
```

Exact pins to be validated by testing on a clean environment.

### 3. API Endpoints (Server)

Two new endpoints registered as a Fastify route plugin:

**`GET /api/python-env/status`**
- Returns `{ ready: boolean, envPath: string }`
- `ready` = true if venv exists AND `python -m whisperx --version` succeeds
- Fast, synchronous check — no side effects

**`GET /api/python-env/setup`**
- SSE stream that drives the full setup
- Each event: `data: { step: string, percent: number, message: string }`
- Steps in order:
  1. `downloading-uv` (0-15%) — download uv binary
  2. `installing-python` (15-35%) — `uv python install 3.11`
  3. `creating-venv` (35-45%) — `uv venv`
  4. `installing-deps` (45-95%) — `uv pip install` (bulk of time, mostly PyTorch)
  5. `verifying` (95-99%) — `python -m whisperx --version`
  6. `done` (100%)
- On error: sends `{ step: "error", message: "..." }` and closes stream
- Idempotent — if already set up, sends `done` immediately

### 4. WhisperService Changes

- Remove `resolvePython3()` method
- Import `pythonEnvService` and call `pythonEnvService.getPythonPath()` instead
- Remove `ensureInstalled()` check — environment is guaranteed ready by app launch
- **Dev mode fallback:** If `pythonEnvService.isReady()` is false, fall back to `resolvePython3()` to preserve the existing dev workflow where developers use their own system WhisperX

### 5. Health Endpoint Changes

- `/api/health` keeps `whisperxAvailable` but now reflects `pythonEnvService.isReady()` instead of shelling out to system python

### 6. Electron Integration

**Changes to `electron/src/main.ts`:**

New `ensurePythonEnv()` function called after server is running, before normal app flow:

1. Call `GET /api/python-env/status`
2. If `ready: true` — skip, continue
3. If `ready: false`:
   - Create a small `BrowserWindow` (~400x200, non-resizable, no menu bar) showing a progress bar, status text, and Lusk logo
   - Connect to `GET /api/python-env/setup` SSE stream
   - Forward events to setup window via `webContents.send('setup-progress', data)`
   - On `done`: close setup window, continue startup
   - On `error`: show error with "Retry" and "Skip" buttons (skip allows app use without transcription)

**Remove** the existing `checkDependencies()` dialog that tells users to run `pip3 install whisperx`.

**Setup window** is a small inline HTML string or `electron/src/setup.html` — progress bar, status text, Lusk logo.

## Edge Cases

### No internet on first launch
The uv download and pip install both require internet. Setup window shows: "Internet connection required for first-time setup. Transcription will be unavailable." with Retry/Skip buttons. App remains usable for everything except transcription.

### Partial installation (interrupted)
Next launch re-runs setup. Each step is idempotent — `uv` checks if Python is already installed, `uv venv` recreates if needed, `uv pip install` is a no-op for already-installed packages.

### Disk space
PyTorch + WhisperX + Python 3.11 is ~2-3GB. WhisperX models (first transcription) add ~3-4GB. If disk is full, pip install fails and the error surfaces in the setup dialog.

### App updates
Python-env persists across Electron updates. If a future version needs different deps, bump `requirements-whisperx.txt` and add a version marker file (`{envDir}/.deps-version`). On launch, if marker doesn't match, re-run `uv pip install`.

### Dev mode
When running via `npm run dev`, setup endpoints are available but optional. Developers can use the managed env or their own system WhisperX. `WhisperService` falls back to system python if managed env isn't ready.

## Files Changed

| File | Change |
|---|---|
| `server/src/services/PythonEnvService.ts` | **New** — uv download, venv creation, dep installation |
| `server/requirements-whisperx.txt` | **New** — pinned WhisperX dependencies |
| `server/src/services/WhisperService.ts` | **Modified** — use PythonEnvService for python path, remove resolvePython3 |
| `server/src/routes/python-env.ts` | **New** — `/api/python-env/status` and `/api/python-env/setup` endpoints |
| `server/src/index.ts` | **Modified** — register python-env routes, update health endpoint |
| `electron/src/main.ts` | **Modified** — add `ensurePythonEnv()`, remove `checkDependencies()` |
| `electron/src/setup.html` | **New** — setup progress dialog HTML |
