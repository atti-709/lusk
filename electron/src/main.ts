import { app, BrowserWindow, dialog } from "electron";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
    importLuskFile(filePath).catch(console.error);
  } else {
    // App is still starting up — process after window is ready
    pendingFilePath = filePath;
  }
});

async function importLuskFile(filePath: string): Promise<void> {
  try {
    const fileBuffer = readFileSync(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer]), fileName);

    const res = await fetch(`http://localhost:${PORT}/api/import`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      const data = (await res.json()) as { sessionId: string };
      mainWindow?.webContents.send("open-session", data.sessionId);
    }
  } catch (err) {
    console.error("Failed to import .lusk file:", err);
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

function checkDependencies(): string[] {
  const missing: string[] = [];
  const env = { ...process.env, PATH: LOGIN_PATH };

  try {
    execSync("python3 --version", { stdio: "pipe", env });
  } catch {
    missing.push("Python 3 (brew install python@3.11)");
  }

  try {
    execSync("python3 -c \"import whisperx\"", { stdio: "pipe", env });
  } catch {
    missing.push("WhisperX (pip3 install whisperx)");
  }

  return missing;
}

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
  let ffmpegPath = "ffmpeg";
  let ffprobePath = "ffprobe";
  try {
    ffmpegPath = require("ffmpeg-static");
  } catch {
    // Fall back to system ffmpeg
  }
  try {
    ffprobePath = require("ffprobe-static").path;
  } catch {
    // Fall back to system ffprobe
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: LOGIN_PATH, // ensure server can find python3, ffmpeg, etc.
    NODE_ENV: "production",
    LUSK_PORT: String(PORT),
    LUSK_TEMP_DIR: tempDir,
    LUSK_CLIENT_DIST: clientDist,
    LUSK_PUBLIC_DIR: publicDir,
    LUSK_REMOTION_ENTRY: remotionEntry,
    LUSK_SERVER_ORIGIN: `http://localhost:${PORT}`,
    FFMPEG_PATH: ffmpegPath,
    FFPROBE_PATH: ffprobePath,
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
      importLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Check for Python/WhisperX
  const missing = checkDependencies();
  if (missing.length > 0) {
    dialog.showMessageBoxSync({
      type: "warning",
      title: "Missing Dependencies",
      message: "Some dependencies are required for transcription:",
      detail: missing.join("\n") +
        "\n\nYou can still use Lusk, but transcription will not work until these are installed.",
      buttons: ["Continue Anyway", "Quit"],
      defaultId: 0,
    }) === 1 && app.quit();
  }

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
