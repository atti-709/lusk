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
| uv version | Pinned (e.g., `0.6.x`) | Prevents CLI flag/behavior changes from breaking setup |
| Env location | `~/Library/Application Support/Lusk/python-env/` | Long-lived, persists across updates, consistent with other app data |
| Python version | 3.11.x | Best compatibility sweet spot for WhisperX + PyTorch + numpy |
| Progress UX | Native Electron modal dialog | Blocks interaction during setup, simple and clear |

## Architecture

```
App Launch
  -> Electron: GET /api/python-env/status
  -> { ready: false }
  -> Show modal dialog: "Setting up transcription engine..."
  -> Electron: POST /api/python-env/setup (SSE stream)
     -> Server: download uv binary -> {envDir}/uv && chmod +x
     -> Server: UV_PYTHON_INSTALL_DIR={envDir}/python uv python install 3.11
     -> Server: uv venv {envDir}/venv --python 3.11
     -> Server: uv pip install --python {envDir}/venv/bin/python -r requirements-whisperx.txt
     -> SSE progress events: { step, percent, message }
  -> Dialog closes on completion
  -> Normal app flow continues
```

## Components

### 1. PythonEnvService (Server)

**New file:** `server/src/services/PythonEnvService.ts`

**Responsibilities:**
- Download the `uv` standalone binary from GitHub releases to `{envDir}/uv` and `chmod +x` it
  - Artifact: `uv-aarch64-apple-darwin.tar.gz` from `https://github.com/astral-sh/uv/releases/download/v{UV_VERSION}/`
  - `UV_VERSION` is a constant pinned in the source (e.g., `0.6.6`)
- Run `uv python install 3.11` with `UV_PYTHON_INSTALL_DIR={envDir}/python` to keep Python self-contained
- Run `uv venv {envDir}/venv --python 3.11` to create the venv
- Run `uv pip install --python {envDir}/venv/bin/python -r requirements-whisperx.txt` to install deps
- Expose `getPythonPath(): string` — returns `{envDir}/venv/bin/python`
- Expose `isReady(): boolean` — checks if venv exists and whisperx is importable
- Emit progress events via a callback during setup
- **Concurrency guard:** Hold an in-memory lock (simple boolean + promise) so concurrent setup calls wait on the same operation rather than racing

**The `envDir` path** is determined by `LUSK_PYTHON_ENV_DIR` env var (set by Electron) or defaults to `{cwd}/.python-env` in dev mode.

**Environment directory structure:**
```
~/Library/Application Support/Lusk/python-env/
  uv              # uv binary (chmod +x)
  python/         # uv-managed Python installation (via UV_PYTHON_INSTALL_DIR)
    cpython-3.11.x-macos-aarch64-none/
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
whisperx==3.3.1
```

Notes:
- Use PyPI release of whisperx (not git) to avoid requiring `git` on user machines
- If PyPI release is too old, fall back to `whisperx @ git+https://...` and document `git` (from Xcode CLT) as a prerequisite
- Exact pins to be validated by testing on a clean environment

### 3. API Endpoints (Server)

Two new endpoints registered as a Fastify route plugin:

**`GET /api/python-env/status`**
- Returns `{ ready: boolean, envPath: string }`
- `ready` = true if venv exists AND `python -m whisperx --version` succeeds
- Fast, synchronous check — no side effects

**`POST /api/python-env/setup`**
- SSE stream that drives the full setup (POST because it has side effects)
- Each event: `data: { step: string, percent: number, message: string }`
- Steps in order:
  1. `downloading-uv` (0-15%) — download uv binary, chmod +x
  2. `installing-python` (15-35%) — `uv python install 3.11`
  3. `creating-venv` (35-45%) — `uv venv`
  4. `installing-deps` (45-95%) — `uv pip install` (bulk of time, mostly PyTorch)
  5. `verifying` (95-99%) — `python -m whisperx --version`
  6. `done` (100%)
- On error: sends `{ step: "error", message: "..." }` and closes stream
- Idempotent — if already set up, sends `done` immediately
- Concurrent calls wait on the same setup operation (lock in PythonEnvService)
- Implementation: use `reply.raw` with `Content-Type: text/event-stream` headers, keep connection open, write SSE-formatted lines

### 4. WhisperService Changes

- Remove `resolvePython3()` method (keep a private copy for dev fallback)
- Import `pythonEnvService` and call `pythonEnvService.getPythonPath()` instead
- Remove `ensureInstalled()` check — environment is guaranteed ready by app launch
- Remove `_availableCache` — no longer needed since `isAvailable()` delegates to `pythonEnvService.isReady()`
- **Dev mode fallback:** If `pythonEnvService.isReady()` is false, fall back to the old `resolvePython3()` logic to preserve the existing dev workflow

### 5. Health Endpoint Changes

- `/api/health` keeps `whisperxAvailable` but now reflects `pythonEnvService.isReady()` instead of shelling out to system python

### 6. Electron Integration

**Changes to `electron/src/main.ts`:**

New `ensurePythonEnv()` function called after server is running, before normal app flow:

1. Call `GET /api/python-env/status`
2. If `ready: true` — skip, continue
3. If `ready: false`:
   - Create a small `BrowserWindow` (~400x200, non-resizable, no menu bar) showing a progress bar, status text, and Lusk logo
   - Connect to `POST /api/python-env/setup` SSE stream
   - Forward events to setup window via `webContents.send('setup-progress', data)`
   - On `done`: close setup window, continue startup
   - On `error`: show error with "Retry" and "Skip" buttons (skip allows app use without transcription)

**Pass env dir to server:** Add `LUSK_PYTHON_ENV_DIR` to the server process env, pointing to `path.join(app.getPath("userData"), "python-env")`.

**Remove** the existing `checkDependencies()` dialog that tells users to run `pip3 install whisperx`.

**Setup window** is a small inline HTML string or `electron/src/setup.html` — progress bar, status text, Lusk logo.

## Edge Cases

### No internet on first launch
The uv download and pip install both require internet. Setup window shows: "Internet connection required for first-time setup. Transcription will be unavailable." with Retry/Skip buttons. App remains usable for everything except transcription.

### Partial installation (interrupted)
Next launch re-runs setup. Each step is idempotent — `uv` re-uses already-downloaded Python, `uv venv` recreates if needed, `uv pip install` skips already-installed packages. This also serves as the retry strategy: clicking "Retry" or relaunching resumes where it left off without re-downloading completed packages.

### Disk space
PyTorch + WhisperX + Python 3.11 is ~2-3GB. WhisperX models (first transcription) add ~3-4GB. If disk is full, pip install fails and the error surfaces in the setup dialog.

### App updates & dependency upgrades
Python-env persists across Electron updates. V1 does not support automatic dependency upgrades — if deps need changing, users will need to delete `python-env/` and relaunch. A future version can add a `.deps-version` marker file for automatic re-install detection.

### Dev mode
When running via `npm run dev`, setup endpoints are available but optional. `LUSK_PYTHON_ENV_DIR` is not set, so PythonEnvService defaults to `{cwd}/.python-env`. Developers can use the managed env (by calling the setup endpoint) or their own system WhisperX — `WhisperService` falls back to system python if managed env isn't ready.

## Files Changed

| File | Change |
|---|---|
| `server/src/services/PythonEnvService.ts` | **New** — uv download, venv creation, dep installation, concurrency lock |
| `server/requirements-whisperx.txt` | **New** — pinned WhisperX dependencies |
| `server/src/services/WhisperService.ts` | **Modified** — use PythonEnvService for python path, remove resolvePython3/ensureInstalled/_availableCache |
| `server/src/routes/python-env.ts` | **New** — `/api/python-env/status` and `POST /api/python-env/setup` endpoints |
| `server/src/index.ts` | **Modified** — register python-env routes, update health endpoint |
| `electron/src/main.ts` | **Modified** — add `ensurePythonEnv()`, pass `LUSK_PYTHON_ENV_DIR`, remove `checkDependencies()` |
| `electron/src/setup.html` | **New** — setup progress dialog HTML |
| `electron/scripts/bundle.ts` | **Modified** — include `requirements-whisperx.txt` in the bundle |
