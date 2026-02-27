import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the absolute path to the ffmpeg binary bundled by ffmpeg-static.
 * Tries multiple strategies because under ELECTRON_RUN_AS_NODE, standard
 * module resolution may not traverse to the monorepo root.
 */
export function resolveFFmpegStatic(): string | null {
  const BIN = path.join("node_modules", "ffmpeg-static", "ffmpeg");

  const fromCwd = path.join(process.cwd(), BIN);
  if (fs.existsSync(fromCwd)) return fromCwd;

  if (process.argv[1]) {
    let dir = path.dirname(path.resolve(process.argv[1]));
    const root = path.parse(dir).root;
    while (dir !== root) {
      const candidate = path.join(dir, BIN);
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
  }

  try {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    const root = path.parse(dir).root;
    while (dir !== root) {
      const candidate = path.join(dir, BIN);
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
  } catch { /* ignore */ }

  return null;
}

/** Get the ffmpeg binary path from env or bundled ffmpeg-static. */
export function getFFmpegPath(): string {
  return process.env.FFMPEG_PATH || resolveFFmpegStatic() || "ffmpeg";
}
