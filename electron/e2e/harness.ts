/**
 * Launches and drives the real Lusk Electron app (main process + server +
 * renderer) via Playwright, in an isolated profile so tests never touch the
 * user's real projects.
 *
 * Targets (LUSK_E2E_TARGET):
 *   dev       electron/dist/main.js with repo server/client builds (default)
 *   packaged  a built Lusk.app — LUSK_E2E_APP overrides the path, otherwise
 *             electron/out/mac-arm64/Lusk.app, then /Applications/Lusk.app
 *
 * Usable from Playwright specs (see fixtures.ts) or ad-hoc scripts:
 *   npx tsx some-script.ts   (import { launchLusk } from ".../e2e/harness")
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ELECTRON_DIR = path.resolve(__dirname, "..");
const APP_SUPPORT = path.join(homedir(), "Library", "Application Support");
/** Real profiles: dev builds use the package name, packaged builds the productName. */
const REAL_PROFILES = [path.join(APP_SUPPORT, "@lusk", "electron"), path.join(APP_SUPPORT, "Lusk")];

export type Target = "dev" | "packaged";

export interface LaunchOptions {
  target?: Target;
  /** Reuse a profile dir (keeps projects between runs). Defaults to a fresh temp dir. */
  userDataDir?: string;
  /** Copy config.json (Gemini key) from the real profile. Default true. */
  seedConfig?: boolean;
  /** Reuse the real profile's Python env so the setup dialog is skipped. Default true. */
  reusePythonEnv?: boolean;
  /** Echo app/server logs to stdout. Default: LUSK_E2E_VERBOSE=1. */
  verbose?: boolean;
  /** Extra env vars for the main process (and thus the server). */
  env?: Record<string, string>;
}

export interface Lusk {
  app: ElectronApplication;
  /** The main window (http://localhost:{port}). */
  window: Page;
  port: number;
  baseUrl: string;
  userDataDir: string;
  /** Combined main-process + server stdout/stderr. */
  logs: string[];
  /** Make the next native save dialog(s) return this path (null = cancel). */
  stubSaveDialog(filePath: string | null): Promise<void>;
  /** Make the next native open dialog(s) return this path (null = cancel). */
  stubOpenDialog(filePath: string | null): Promise<void>;
  /** Fetch JSON from the app's server. */
  api<T = unknown>(urlPath: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

export function resolveTarget(): Target {
  return process.env.LUSK_E2E_TARGET === "packaged" ? "packaged" : "dev";
}

function packagedExecutable(): string {
  const candidates = [
    process.env.LUSK_E2E_APP,
    path.join(ELECTRON_DIR, "out", "mac-arm64", "Lusk.app"),
    "/Applications/Lusk.app",
  ].filter((p): p is string => !!p);
  for (const app of candidates) {
    const exe = app.endsWith(".app") ? path.join(app, "Contents", "MacOS", "Lusk") : app;
    if (existsSync(exe)) return exe;
  }
  throw new Error(`No packaged Lusk.app found (tried ${candidates.join(", ")})`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function findReal(file: string): string | null {
  for (const dir of REAL_PROFILES) {
    const p = path.join(dir, file);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function launchLusk(opts: LaunchOptions = {}): Promise<Lusk> {
  const target = opts.target ?? resolveTarget();
  const verbose = opts.verbose ?? process.env.LUSK_E2E_VERBOSE === "1";
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;

  const isTempProfile = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? (await mkdtemp(path.join(tmpdir(), "lusk-e2e-")));
  await mkdir(userDataDir, { recursive: true });

  if (opts.seedConfig ?? true) {
    const realConfig = findReal("config.json");
    const dest = path.join(userDataDir, "config.json");
    if (realConfig && !existsSync(dest)) await copyFile(realConfig, dest);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LUSK_PORT: String(port),
    LUSK_USER_DATA_DIR: userDataDir,
    LUSK_DISABLE_AUTO_UPDATE: "1",
    ...opts.env,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (opts.reusePythonEnv ?? true) {
    const realPython = findReal("python-env");
    if (realPython && !opts.env?.LUSK_PYTHON_ENV_DIR) env.LUSK_PYTHON_ENV_DIR = realPython;
  }

  const mainJs = path.join(ELECTRON_DIR, "dist", "main.js");
  if (target === "dev" && !existsSync(mainJs)) {
    throw new Error("electron/dist/main.js missing — run `npm run build:electron` first");
  }

  const app = await electron.launch(
    target === "dev"
      ? { args: [mainJs], cwd: ELECTRON_DIR, env }
      : { executablePath: packagedExecutable(), args: [], env },
  );

  // Builds that predate the LUSK_USER_DATA_DIR override would run against the
  // user's real profile — bail out before the window/server do any work.
  const actualUserData = await app.evaluate(({ app }) => app.getPath("userData"));
  if (path.resolve(actualUserData) !== path.resolve(userDataDir)) {
    await app.close().catch(() => {});
    throw new Error(
      `App ignored LUSK_USER_DATA_DIR (using ${actualUserData}). ` +
        "This build predates the e2e overrides — rebuild it with `npm run package`.",
    );
  }

  const logs: string[] = [];
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    if (verbose) process.stdout.write(text);
  };
  app.process().stdout?.on("data", capture);
  app.process().stderr?.on("data", capture);

  // The Python setup window may come first; wait for the main window.
  // Server startup + Python env check can take a while on a cold start.
  const isMain = (p: Page) => p.url().startsWith(baseUrl);
  let window = app.windows().find(isMain);
  const deadline = Date.now() + 90_000;
  while (!window) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await app.close().catch(() => {});
      throw new Error(`Main window never appeared.\n--- logs ---\n${logs.join("").slice(-4000)}`);
    }
    const next = await app.waitForEvent("window", { timeout: remaining }).catch(() => null);
    window = next && isMain(next) ? next : app.windows().find(isMain);
  }
  await window.waitForLoadState("domcontentloaded");

  const stubDialog = (kind: "save" | "open") => (filePath: string | null) =>
    app.evaluate(
      ({ dialog }, { kind, filePath }) => {
        if (kind === "save") {
          dialog.showSaveDialog = (async () => ({
            canceled: filePath === null,
            filePath: filePath ?? "",
          })) as typeof dialog.showSaveDialog;
        } else {
          dialog.showOpenDialog = (async () => ({
            canceled: filePath === null,
            filePaths: filePath === null ? [] : [filePath],
          })) as typeof dialog.showOpenDialog;
        }
      },
      { kind, filePath },
    );

  return {
    app,
    window,
    port,
    baseUrl,
    userDataDir,
    logs,
    stubSaveDialog: stubDialog("save"),
    stubOpenDialog: stubDialog("open"),
    async api<T>(urlPath: string, init?: RequestInit) {
      const res = await fetch(`${baseUrl}${urlPath}`, init);
      if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${urlPath} → ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    },
    async close() {
      await app.close().catch(() => {});
      if (isTempProfile) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
