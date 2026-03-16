# UV-Based Python Environment Management — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically manage a Python 3.11 environment with pinned WhisperX dependencies using `uv`, eliminating manual Python/pip setup for users.

**Architecture:** New `PythonEnvService` on the server handles downloading `uv`, creating a venv, and installing deps. Two new API endpoints (`/api/python-env/status` and `POST /api/python-env/setup`) expose this to Electron. On launch, Electron checks readiness and shows a native setup dialog if needed.

**Tech Stack:** uv (Python package manager), Python 3.11, Fastify SSE, Electron BrowserWindow

**Spec:** `docs/superpowers/specs/2026-03-16-uv-python-env-management-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/services/PythonEnvService.ts` | **New** — Download uv, create venv, install deps, expose `getPythonPath()` and `isReady()` |
| `server/requirements-whisperx.txt` | **New** — Pinned WhisperX + PyTorch dependencies |
| `server/src/routes/python-env.ts` | **New** — `/api/python-env/status` GET and `/api/python-env/setup` POST (SSE) |
| `server/src/index.ts` | **Modify** — Register python-env routes, update health endpoint |
| `server/src/services/WhisperService.ts` | **Modify** — Use PythonEnvService for python path |
| `electron/src/main.ts` | **Modify** — Add `ensurePythonEnv()` with inline setup HTML, pass `LUSK_PYTHON_ENV_DIR`, remove `checkDependencies()` |
| `electron/scripts/bundle.ts` | **Modify** — Copy `requirements-whisperx.txt` into bundle |

---

## Chunk 1: Server — PythonEnvService + Requirements

### Task 1: Create requirements-whisperx.txt

**Files:**
- Create: `server/requirements-whisperx.txt`

- [ ] **Step 1: Create the requirements file**

```
torch==2.5.1
torchaudio==2.5.1
numpy<2
whisperx==3.3.1
```

- [ ] **Step 2: Commit**

```bash
git add server/requirements-whisperx.txt
git commit -m "feat: add pinned WhisperX requirements file"
```

---

### Task 2: Create PythonEnvService — uv download

**Files:**
- Create: `server/src/services/PythonEnvService.ts`

- [ ] **Step 1: Create PythonEnvService with uv download logic**

Create `server/src/services/PythonEnvService.ts` with:

```typescript
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { chmod, mkdir, access, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const UV_VERSION = "0.6.6";
const UV_ARTIFACT = `uv-aarch64-apple-darwin.tar.gz`;
const UV_URL = `https://github.com/astral-sh/uv/releases/download/v${UV_VERSION}/${UV_ARTIFACT}`;
const PYTHON_VERSION = "3.11";

export type SetupProgressCallback = (step: string, percent: number, message: string) => void;

function getEnvDir(): string {
  return process.env.LUSK_PYTHON_ENV_DIR ?? path.join(process.cwd(), ".python-env");
}

class PythonEnvService {
  private setupPromise: Promise<void> | null = null;

  get envDir(): string {
    return getEnvDir();
  }

  get uvPath(): string {
    return path.join(this.envDir, "uv");
  }

  get venvDir(): string {
    return path.join(this.envDir, "venv");
  }

  getPythonPath(): string {
    return path.join(this.venvDir, "bin", "python");
  }

  isReady(): boolean {
    try {
      execFileSync(this.getPythonPath(), ["-m", "whisperx", "--version"], {
        stdio: "pipe",
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async setup(onProgress?: SetupProgressCallback): Promise<void> {
    // Concurrency guard: if setup is already running, wait on the same promise
    if (this.setupPromise) {
      return this.setupPromise;
    }

    this.setupPromise = this._doSetup(onProgress).finally(() => {
      this.setupPromise = null;
    });

    return this.setupPromise;
  }

  private async _doSetup(onProgress?: SetupProgressCallback): Promise<void> {
    await mkdir(this.envDir, { recursive: true });

    // Step 1: Download uv
    if (!await this.fileExists(this.uvPath)) {
      onProgress?.("downloading-uv", 0, "Downloading uv package manager...");
      await this.downloadUv();
    }
    onProgress?.("downloading-uv", 15, "uv ready");

    // Step 2: Install Python
    onProgress?.("installing-python", 15, "Installing Python 3.11...");
    await this.installPython(onProgress);
    onProgress?.("installing-python", 35, "Python 3.11 installed");

    // Step 3: Create venv
    onProgress?.("creating-venv", 35, "Creating virtual environment...");
    await this.createVenv();
    onProgress?.("creating-venv", 45, "Virtual environment created");

    // Step 4: Install dependencies
    onProgress?.("installing-deps", 45, "Installing WhisperX and dependencies (this may take a few minutes)...");
    await this.installDeps(onProgress);
    onProgress?.("installing-deps", 95, "Dependencies installed");

    // Step 5: Verify
    onProgress?.("verifying", 95, "Verifying installation...");
    if (!this.isReady()) {
      throw new Error("WhisperX verification failed after installation");
    }
    onProgress?.("done", 100, "Setup complete");
  }

  private async downloadUv(): Promise<void> {
    const tarPath = path.join(this.envDir, UV_ARTIFACT);

    // Download the tarball
    const res = await fetch(UV_URL);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download uv: HTTP ${res.status}`);
    }
    const fileStream = createWriteStream(tarPath);
    await pipeline(Readable.fromWeb(res.body as any), fileStream);

    // Extract using system tar (always available on macOS)
    execFileSync("tar", ["-xzf", tarPath, "--strip-components=1", "-C", this.envDir, "--include", "*/uv"], {
      stdio: "pipe",
    });

    // Make executable
    await chmod(this.uvPath, 0o755);

    // Clean up tarball
    await unlink(tarPath).catch(() => {});
  }

  private async installPython(onProgress?: SetupProgressCallback): Promise<void> {
    await this.runUv(["python", "install", PYTHON_VERSION], {
      UV_PYTHON_INSTALL_DIR: path.join(this.envDir, "python"),
    });
  }

  private async createVenv(): Promise<void> {
    await this.runUv(["venv", this.venvDir, "--python", PYTHON_VERSION], {
      UV_PYTHON_INSTALL_DIR: path.join(this.envDir, "python"),
    });
  }

  private async installDeps(onProgress?: SetupProgressCallback): Promise<void> {
    const requirementsPath = this.resolveRequirementsPath();
    await this.runUv(
      ["pip", "install", "--python", this.getPythonPath(), "-r", requirementsPath],
      {},
      (line) => {
        // Parse uv pip install progress from stderr
        // uv outputs lines like "Downloading package..." or "Installing package..."
        if (line.includes("Downloading") || line.includes("Installing")) {
          onProgress?.("installing-deps", 55, line.trim().slice(0, 80));
        }
      },
    );
  }

  /**
   * Find the requirements file. In the bundled Electron app it's
   * inside the server bundle; in dev it's at server/requirements-whisperx.txt.
   */
  private resolveRequirementsPath(): string {
    const candidates = [
      path.join(import.meta.dirname, "../../requirements-whisperx.txt"), // server/dist/services -> server/
      path.join(import.meta.dirname, "../requirements-whisperx.txt"),    // server/dist -> server/
      path.join(process.cwd(), "server/requirements-whisperx.txt"),     // dev: repo root
    ];
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
    throw new Error("requirements-whisperx.txt not found");
  }

  private runUv(
    args: string[],
    extraEnv: Record<string, string>,
    onStderr?: (line: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.uvPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      });

      let stderr = "";
      let partialLine = "";

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (onStderr) {
          const combined = partialLine + text;
          const lines = combined.split("\n");
          partialLine = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) onStderr(line);
          }
        }
      });

      proc.stdout.on("data", () => {}); // drain

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`uv ${args[0]} failed (code ${code}): ${stderr.slice(-500)}`));
        } else {
          resolve();
        }
      });

      proc.on("error", reject);
    });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export const pythonEnvService = new PythonEnvService();
export { PythonEnvService };
```

- [ ] **Step 2: Verify the service compiles**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p server/tsconfig.json`
Expected: No type errors (or only pre-existing ones unrelated to our changes)

- [ ] **Step 3: Commit**

```bash
git add server/src/services/PythonEnvService.ts
git commit -m "feat: add PythonEnvService for uv-managed Python environment"
```

---

### Task 3: Create python-env API routes

**Files:**
- Create: `server/src/routes/python-env.ts`

- [ ] **Step 1: Create the route plugin**

Create `server/src/routes/python-env.ts` following the existing route pattern (see `server/src/routes/settings.ts` for reference):

```typescript
import type { FastifyPluginAsync } from "fastify";
import { pythonEnvService } from "../services/PythonEnvService.js";

export const pythonEnvRoute: FastifyPluginAsync = async (server) => {
  // Status check — fast, no side effects
  server.get("/api/python-env/status", async () => {
    return {
      ready: pythonEnvService.isReady(),
      envPath: pythonEnvService.envDir,
    };
  });

  // Setup — SSE stream that drives the full installation
  server.post("/api/python-env/setup", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (data: { step: string; percent: number; message: string }) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // If already set up, short-circuit
    if (pythonEnvService.isReady()) {
      send({ step: "done", percent: 100, message: "Already set up" });
      reply.raw.end();
      return reply;
    }

    try {
      await pythonEnvService.setup((step, percent, message) => {
        send({ step, percent, message });
      });
    } catch (err: any) {
      send({ step: "error", percent: 0, message: err.message ?? "Setup failed" });
    }

    reply.raw.end();
    return reply;
  });
};
```

- [ ] **Step 2: Register the route in server/src/index.ts**

In `server/src/index.ts`:

1. Replace the `whisperService` import with `pythonEnvService`:
```typescript
// Remove: import { whisperService } from "./services/WhisperService.js";
// Add these two:
import { pythonEnvRoute } from "./routes/python-env.js";
import { pythonEnvService } from "./services/PythonEnvService.js";
```

2. Register the route after the existing routes (after `settingsRoute` registration):
```typescript
await server.register(pythonEnvRoute);
```

3. In the `/api/health` handler, change:
```typescript
const whisperxAvailable = await whisperService.isAvailable();
```
To:
```typescript
const whisperxAvailable = pythonEnvService.isReady();
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p server/tsconfig.json`
Expected: No new type errors

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/python-env.ts server/src/index.ts
git commit -m "feat: add python-env API routes (status + SSE setup)"
```

---

### Task 4: Update WhisperService to use PythonEnvService

**Files:**
- Modify: `server/src/services/WhisperService.ts:36-82`

- [ ] **Step 1: Update WhisperService**

In `server/src/services/WhisperService.ts`:

1. Add import at the top (after line 6):
```typescript
import { pythonEnvService } from "./PythonEnvService.js";
```

2. Remove the `_availableCache` field and replace `isAvailable()`:
```typescript
async isAvailable(): Promise<boolean> {
  if (pythonEnvService.isReady()) return true;
  // Dev fallback: check system python
  return this.checkSystemWhisperX();
}

private checkSystemWhisperX(): boolean {
  const python3 = this.resolvePython3();
  try {
    execFileSync(python3, ["-m", "whisperx", "--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
```

3. Keep `resolvePython3()` as-is (it's already private) — it's used by the dev fallback above.

4. Update `ensureInstalled()` to prefer managed env:
```typescript
private async ensureInstalled(onProgress?: ProgressCallback): Promise<string> {
  onProgress?.(2, "Checking WhisperX...");

  // Prefer managed environment
  if (pythonEnvService.isReady()) {
    onProgress?.(5, "WhisperX ready (managed env)");
    return pythonEnvService.getPythonPath();
  }

  // Dev fallback: system python
  const python3 = this.resolvePython3();
  try {
    execFileSync(python3, ["-m", "whisperx", "--version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      `WhisperX is not installed. Run the setup from the app or: pip3 install whisperx (python3: ${python3})`
    );
  }

  onProgress?.(5, "WhisperX ready (system)");
  return python3;
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p server/tsconfig.json`
Expected: No new type errors

- [ ] **Step 3: Commit**

```bash
git add server/src/services/WhisperService.ts
git commit -m "feat: WhisperService uses managed Python env with system fallback"
```

---

## Chunk 2: Electron — Setup Dialog + Integration

### Task 5: Add ensurePythonEnv() to Electron main process

**Files:**
- Modify: `electron/src/main.ts`

Note: Instead of a separate `setup.html` file (which `tsc` wouldn't copy to `dist/` and would need special bundling), we embed the HTML inline as a data URL. This avoids file-path issues in both dev and packaged builds.

- [ ] **Step 1: Add LUSK_PYTHON_ENV_DIR to server env vars**

In `electron/src/main.ts`, add to the `env` object inside `startServer()` (after `LUSK_SERVER_ORIGIN`):

```typescript
LUSK_PYTHON_ENV_DIR: path.join(app.getPath("userData"), "python-env"),
```

- [ ] **Step 2: Add the inline setup HTML and ensurePythonEnv() function**

Add the following after the `checkDependencies` function (around line 262). The setup HTML is embedded as a string to avoid file-path issues with `tsc` and Electron packaging:

```typescript
const SETUP_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Lusk Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;padding:24px;-webkit-app-region:drag;user-select:none}
h1{font-size:16px;font-weight:600;margin-bottom:16px;color:#fff}
.progress-container{width:100%;max-width:320px;background:#2a2a4a;border-radius:8px;overflow:hidden;height:8px;margin-bottom:12px}
.progress-bar{height:100%;background:linear-gradient(90deg,#7c3aed,#a855f7);width:0%;transition:width .3s ease;border-radius:8px}
.status{font-size:13px;color:#a0a0c0;text-align:center;min-height:20px}
.error-container{display:none;text-align:center}
.error-container.visible{display:block}
.error-message{color:#f87171;font-size:13px;margin-bottom:16px;max-height:60px;overflow-y:auto}
.buttons{display:flex;gap:8px;justify-content:center}
button{-webkit-app-region:no-drag;padding:8px 20px;border-radius:6px;border:none;font-size:13px;cursor:pointer;font-weight:500}
.btn-primary{background:#7c3aed;color:#fff}
.btn-secondary{background:#3a3a5a;color:#c0c0d0}
</style></head><body>
<h1>Setting up transcription engine...</h1>
<div class="progress-container"><div class="progress-bar" id="progress"></div></div>
<div class="status" id="status">Preparing...</div>
<div class="error-container" id="errorContainer">
<div class="error-message" id="errorMessage"></div>
<div class="buttons"><button class="btn-primary" id="retryBtn">Retry</button><button class="btn-secondary" id="skipBtn">Skip</button></div>
</div>
<script>
const{ipcRenderer}=require("electron");
ipcRenderer.on("setup-progress",(_,d)=>{
  if(d.step==="error"){document.getElementById("status").style.display="none";document.querySelector(".progress-container").style.display="none";document.getElementById("errorContainer").classList.add("visible");document.getElementById("errorMessage").textContent=d.message;return}
  document.getElementById("progress").style.width=d.percent+"%";document.getElementById("status").textContent=d.message;
});
document.getElementById("retryBtn").addEventListener("click",()=>ipcRenderer.send("setup-retry"));
document.getElementById("skipBtn").addEventListener("click",()=>ipcRenderer.send("setup-skip"));
</script></body></html>`;

async function ensurePythonEnv(): Promise<void> {
  // Check if Python env is already set up
  try {
    const statusRes = await fetch(`http://localhost:${PORT}/api/python-env/status`);
    const status = (await statusRes.json()) as { ready: boolean };
    if (status.ready) return;
  } catch {
    return; // Server not responding, skip
  }

  return new Promise<void>((resolve) => {
    const setupWindow = new BrowserWindow({
      width: 400,
      height: 200,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      frame: false,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const loadSetupPage = () => {
      setupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SETUP_HTML)}`);
    };

    loadSetupPage();
    setupWindow.once("ready-to-show", () => setupWindow.show());

    const cleanup = () => {
      ipcMain.removeAllListeners("setup-retry");
      ipcMain.removeAllListeners("setup-skip");
    };

    const runSetup = () => {
      fetch(`http://localhost:${PORT}/api/python-env/setup`, { method: "POST" })
        .then(async (res) => {
          if (!res.body) throw new Error("No response body");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";

            for (const event of events) {
              const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              const data = JSON.parse(dataLine.slice(6));
              setupWindow.webContents.send("setup-progress", data);

              if (data.step === "done") {
                cleanup();
                setupWindow.destroy();
                resolve();
                return;
              }
            }
          }

          // Stream ended without "done" — treat as error
          setupWindow.webContents.send("setup-progress", {
            step: "error",
            percent: 0,
            message: "Setup stream ended unexpectedly",
          });
        })
        .catch((err) => {
          setupWindow.webContents.send("setup-progress", {
            step: "error",
            percent: 0,
            message: err.message ?? "Connection failed",
          });
        });
    };

    // Handle retry/skip from the setup window
    ipcMain.once("setup-skip", () => {
      cleanup();
      setupWindow.destroy();
      resolve();
    });

    ipcMain.on("setup-retry", () => {
      loadSetupPage();
      setupWindow.once("ready-to-show", () => runSetup());
    });

    runSetup();
  });
}
```

- [ ] **Step 3: Wire it into the startup flow**

In `electron/src/main.ts`, in the `app.whenReady()` handler, add `ensurePythonEnv()` after `startServer()` and before `createWindow()`:

```typescript
  await ensurePythonEnv();

  createWindow();
```

- [ ] **Step 4: Remove checkDependencies() and clean up imports**

1. Delete the entire `checkDependencies()` function (lines 234-261).
2. Remove its call from the `did-finish-load` handler. Change:
```typescript
  mainWindow!.webContents.once("did-finish-load", async () => {
    if (pendingFilePath) {
      openLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
    await checkDependencies();
  });
```
To:
```typescript
  mainWindow!.webContents.once("did-finish-load", async () => {
    if (pendingFilePath) {
      openLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
  });
```
3. Remove `clipboard` from the Electron import (line 1) — it was only used by `checkDependencies`.

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/atti/Source/Repos/lusk && npx tsc --noEmit -p electron/tsconfig.json`
Expected: No new type errors

- [ ] **Step 6: Commit**

```bash
git add electron/src/main.ts
git commit -m "feat: Electron auto-bootstraps Python env on launch"
```

---

## Chunk 3: Bundle Script + Final Integration

### Task 7: Update bundle script to include requirements file

**Files:**
- Modify: `electron/scripts/bundle.ts:36`

- [ ] **Step 1: Add requirements copy to bundle script**

In `electron/scripts/bundle.ts`, after line 36 (`copyDir(...)` for server dist), add:

```typescript
// Copy WhisperX requirements for PythonEnvService
fs.copyFileSync(
  path.join(ROOT, "server/requirements-whisperx.txt"),
  path.join(serverBundle, "requirements-whisperx.txt"),
);
```

- [ ] **Step 2: Commit**

```bash
git add electron/scripts/bundle.ts
git commit -m "feat: include requirements-whisperx.txt in Electron bundle"
```

---

### Task 8: Manual integration test

- [ ] **Step 1: Start the dev server**

Run: `cd /Users/atti/Source/Repos/lusk && npm run dev`

- [ ] **Step 2: Test the status endpoint**

Run: `curl http://localhost:3000/api/python-env/status`
Expected: `{ "ready": false, "envPath": "..." }` (or `true` if you already have a managed env)

- [ ] **Step 3: Test the setup endpoint**

Run: `curl -X POST http://localhost:3000/api/python-env/setup`
Expected: SSE events streaming — downloading uv, installing Python, creating venv, installing deps, done. This will take several minutes on first run.

- [ ] **Step 4: Verify WhisperX works through managed env**

Run: `curl http://localhost:3000/api/python-env/status`
Expected: `{ "ready": true, "envPath": "..." }`

Run: `curl http://localhost:3000/api/health`
Expected: `{ "status": "ok", ..., "whisperxAvailable": true }`

- [ ] **Step 5: Test Electron setup dialog (packaged or dev)**

If testing the Electron app: delete `~/Library/Application Support/Lusk/python-env/` and relaunch. The setup dialog should appear, show progress, and close on completion. Verify the app opens normally after setup.

- [ ] **Step 6: Test transcription still works**

Upload a video through the UI and run transcription. It should use the managed Python environment.

- [ ] **Step 7: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration test fixes for Python env management"
```
