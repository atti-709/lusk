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
  private _readyCache: boolean | null = null;

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
    if (this._readyCache === true) return true;
    // Fast negative: if the python binary doesn't exist, skip the exec
    try {
      statSync(this.getPythonPath());
    } catch {
      return false;
    }
    try {
      execFileSync(this.getPythonPath(), ["-c", "import whisperx; print(whisperx.__version__)"], {
        stdio: "pipe",
        timeout: 10_000,
      });
      this._readyCache = true;
      return true;
    } catch {
      return false;
    }
  }

  get isSettingUp(): boolean {
    return this.setupPromise !== null;
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
    await this.installPython();
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

  private async installPython(): Promise<void> {
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
        stderr = (stderr + text).slice(-2000);
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
