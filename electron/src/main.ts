import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from "electron";
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
    isQuitting = true;
    killServer();
    autoUpdater.quitAndInstall(false, true);
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

async function checkDependencies(): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    const health = (await res.json()) as { whisperxAvailable: boolean };

    if (!health.whisperxAvailable && mainWindow) {
      const commands = "brew install python3\npip3 install whisperx";
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Missing Dependencies",
        message: "WhisperX is not installed",
        detail:
          "Lusk needs Python 3 and WhisperX for transcription.\n\n" +
          "Run these commands in Terminal:\n\n" +
          commands +
          "\n\nTranscription won't work until these are installed.\n" +
          "You can still use Lusk for editing and rendering.",
        buttons: ["Copy Commands to Clipboard", "Continue"],
        defaultId: 0,
      });
      if (response === 0) {
        clipboard.writeText(commands);
      }
    }
  } catch {
    // Health check failed — server may still be starting, skip silently
  }
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

  createWindow();

  // Check for updates (only in packaged app — dev builds have no publish config)
  if (app.isPackaged) {
    setupAutoUpdater();
  }

  // Once the page has loaded, process pending files and check dependencies
  mainWindow!.webContents.once("did-finish-load", async () => {
    if (pendingFilePath) {
      openLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
    await checkDependencies();
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
