import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = 3000;
let serverProcess: ChildProcess | null = null;
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
    // extraResource copies ./bundle → Contents/Resources/bundle/
    return path.join(process.resourcesPath, "bundle", ...segments);
  }
  // In dev: electron/dist/main.js → go up to monorepo root
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

  // Resolve ffmpeg/ffprobe from the bundled npm packages
  let ffmpegPath: string | undefined;
  let ffprobePath: string | undefined;
  try {
    ffmpegPath = require("ffmpeg-static");
  } catch {
    // Will be resolved by the server instead
  }
  try {
    ffprobePath = require("ffprobe-static").path;
  } catch {
    // Will be resolved by the server instead
  }

  // Validate and fix binary permissions for packaged app
  for (const binPath of [ffmpegPath, ffprobePath]) {
    if (binPath && path.isAbsolute(binPath) && existsSync(binPath)) {
      // macOS quarantine can prevent execution of downloaded binaries
      try {
        execSync(`xattr -dr com.apple.quarantine "${binPath}"`, {
          stdio: "ignore",
        });
      } catch {
        // Attribute may not exist — that's fine
      }
    }
  }

  console.log(`[lusk] ffmpeg: ${ffmpegPath ?? "(server will resolve)"}`);
  console.log(`[lusk] ffprobe: ${ffprobePath ?? "(server will resolve)"}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: LOGIN_PATH, // ensure server can find python3, ffmpeg, etc.
    NODE_ENV: "production",
    LUSK_PORT: String(PORT),
    LUSK_TEMP_DIR: tempDir,
    LUSK_REGISTRY_DIR: path.join(app.getPath("userData")),
    LUSK_CLIENT_DIST: clientDist,
    LUSK_PUBLIC_DIR: publicDir,
    LUSK_REMOTION_ENTRY: remotionEntry,
    LUSK_SERVER_ORIGIN: `http://localhost:${PORT}`,
    ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {}),
    ...(ffprobePath ? { FFPROBE_PATH: ffprobePath } : {}),
  };

  // Use Electron itself as the Node runtime (ELECTRON_RUN_AS_NODE=1).
  // This avoids needing a separate `node` binary in the packaged app.
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverStderr = "";

  serverProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[server] ${data.toString().trimEnd()}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trimEnd();
    console.error(`[server] ${text}`);
    serverStderr = (serverStderr + "\n" + text).slice(-2000);
  });

  serverProcess.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
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

  // Once the page has loaded, process any file that was opened at launch
  mainWindow.webContents.once("did-finish-load", () => {
    if (pendingFilePath) {
      openLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
  });

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
  killServer();
});
