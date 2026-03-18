import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = 3000;
let serverProcess: ChildProcess | null = null;

// ── Terminal color helpers ──────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
  cyan:  "\x1b[36m",
  yellow:"\x1b[33m",
  red:   "\x1b[31m",
};

function prefixLines(prefix: string, data: Buffer): string {
  return data
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => `${prefix} ${line}`)
    .join("\n");
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let pendingFilePath: string | null = null;

// Must be registered before app.whenReady() to catch file opens at launch
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!filePath.endsWith(".lusk")) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    // App already running — import immediately
    openLuskFile(filePath).catch(console.error);
  } else {
    // App is still starting up — process after window is ready
    pendingFilePath = filePath;
  }
});

async function openLuskFile(filePath: string): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: filePath }),
    });

    if (res.ok) {
      const data = (await res.json()) as { projectId: string };
      mainWindow?.webContents.send("open-session", data.projectId);
    }
  } catch (err) {
    console.error("Failed to open .lusk file:", err);
  }
}

/**
 * Resolve a path relative to the monorepo root.
 * In the packaged app, extraResource files land in Contents/Resources/.
 * In dev, we resolve relative to electron/dist/ (where compiled main.js lives).
 */
function getResourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bundle", ...segments);
  }
  return path.join(__dirname, "../..", ...segments);
}

/**
 * Get the user's full login shell PATH.
 * Electron launches with a minimal PATH that omits Homebrew (/opt/homebrew/bin),
 * pyenv, etc. Running through the login shell sources ~/.zprofile / ~/.bash_profile.
 */
function getLoginShellPath(): string {
  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    return execSync(`${shell} -lc "echo $PATH"`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return process.env.PATH ?? "";
  }
}

const LOGIN_PATH = getLoginShellPath();

async function waitForServer(retries = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Server failed to start within 15 seconds");
}

async function startServer(): Promise<void> {
  const serverEntry = getResourcePath("server", "dist", "index.js");
  const clientDist = getResourcePath("client", "dist");
  const publicDir = getResourcePath("client", "public");
  const remotionEntry = getResourcePath(
    "client",
    "src",
    "remotion",
    "index.ts"
  );
  const tempDir = path.join(app.getPath("userData"), "lusk_temp");

  // ffmpeg/ffprobe: let the server resolve them from its own node_modules
  // (bundle/server/node_modules/ffmpeg-static). Don't pass paths from the
  // Electron main process — they point inside the asar archive and fail
  // with ENOTDIR when the server tries to exec them.
  const lusk = `${C.yellow}[lusk]${C.reset}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: LOGIN_PATH, // ensure server can find python3, ffmpeg, etc.
    HOME: app.getPath("home"), // Finder-launched apps may have HOME=/ which breaks Remotion's ~/.remotion cache
    NODE_ENV: app.isPackaged ? "production" : "development",
    LUSK_PORT: String(PORT),
    LUSK_TEMP_DIR: tempDir,
    LUSK_REGISTRY_DIR: path.join(app.getPath("userData")),
    LUSK_CLIENT_DIST: clientDist,
    LUSK_PUBLIC_DIR: publicDir,
    LUSK_REMOTION_ENTRY: remotionEntry,
    LUSK_SERVER_ORIGIN: `http://localhost:${PORT}`,
    LUSK_PYTHON_ENV_DIR: path.join(app.getPath("userData"), "python-env"),
  };

  // Use Electron itself as the Node runtime (ELECTRON_RUN_AS_NODE=1).
  // This avoids needing a separate `node` binary in the packaged app.
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    cwd: app.getPath("home"), // Ensure cwd is home dir so Remotion resolves ~/.remotion correctly
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverStderr = "";
  const serverOut = `${C.cyan}[server]${C.reset}`;
  const serverErr = `${C.red}[server]${C.reset}`;

  serverProcess.stdout?.on("data", (data: Buffer) => {
    console.log(prefixLines(serverOut, data));
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trimEnd();
    console.error(prefixLines(serverErr, data));
    serverStderr = (serverStderr + "\n" + text).slice(-2000);
  });

  serverProcess.on("exit", (code) => {
    console.log(`${C.yellow}[lusk]${C.reset} server exited (code ${code})`);
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "Server Error",
        "The Lusk server has stopped unexpectedly. Please restart the app."
      );
      app.quit();
    }
  });

  try {
    await waitForServer();
  } catch (err) {
    throw new Error(`${err}${serverStderr ? `\n\nServer output:\n${serverStderr}` : ""}`);
  }
}

function killServer(): void {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", async (info) => {
    if (!mainWindow) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Available",
      message: `A new version (${info.version}) is available.`,
      detail: "Would you like to download it now?",
      buttons: ["Download", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      mainWindow.webContents.send("update-downloading");
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    if (!mainWindow) return;
    mainWindow.setProgressBar(progress.percent / 100);
    mainWindow.webContents.send("update-progress", progress.percent);
  });

  autoUpdater.on("update-downloaded", () => {
    if (!mainWindow) return;
    mainWindow.setProgressBar(-1);
    mainWindow.webContents.send("update-progress", 100);
    isQuitting = true;
    killServer();
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 1500);
  });

  autoUpdater.on("error", (err) => {
    if (!mainWindow) return;
    mainWindow.setProgressBar(-1);
    mainWindow.webContents.send("update-error", err.message ?? "Download failed");
    console.error("Auto-updater error:", err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.log("Update check failed (offline?):", err.message);
  });
}

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox(
      "Failed to Start",
      `The Lusk server could not be started.\n\n${err}`
    );
    app.quit();
    return;
  }

  await ensurePythonEnv();
  createWindow();

  // Check for updates (only in packaged app — dev builds have no publish config)
  if (app.isPackaged) {
    setupAutoUpdater();
  }

  // Once the page has loaded, process any pending file opens
  mainWindow!.webContents.once("did-finish-load", async () => {
    if (pendingFilePath) {
      openLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
  });

  // macOS: explicit app menu ensures Cmd+Q (Quit) works
  if (process.platform === "darwin") {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: "about" as const },
          { type: "separator" as const },
          {
            label: "Check for Updates\u2026",
            click: () => {
              autoUpdater.checkForUpdatesAndNotify().catch(console.error);
            },
          },
          { type: "separator" as const },
          { role: "quit" as const },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" as const },
          { role: "redo" as const },
          { type: "separator" as const },
          { role: "cut" as const },
          { role: "copy" as const },
          { role: "paste" as const },
          { role: "selectAll" as const },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "toggleDevTools" as const },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // IPC handlers for native file dialogs
  ipcMain.handle("show-save-dialog", async (_event, options: any) => {
    if (!mainWindow) return { canceled: true, filePath: null };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title ?? "Save",
      defaultPath: options.defaultPath,
      filters: options.filters ?? [{ name: "Lusk Project", extensions: ["lusk"] }],
    });
    return { canceled: result.canceled, filePath: result.filePath ?? null };
  });

  ipcMain.handle("show-open-dialog", async (_event, options: any) => {
    if (!mainWindow) return { canceled: true, filePath: null };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title ?? "Open",
      defaultPath: options.defaultPath,
      filters: options.filters ?? [{ name: "Lusk Project", extensions: ["lusk"] }],
      properties: ["openFile"],
    });
    return {
      canceled: result.canceled,
      filePath: result.filePaths?.[0] ?? null,
    };
  });

  ipcMain.handle("read-file", async (_event, filePath: string) => {
    return readFile(filePath, "utf-8");
  });

  ipcMain.handle("write-file", async (_event, filePath: string, base64Data: string) => {
    await writeFile(filePath, Buffer.from(base64Data, "base64"));
  });

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  killServer();
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  // Destroy the window directly to bypass the renderer's beforeunload guard,
  // which would otherwise block Cmd+Q when a process is running.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  killServer();
});
