import { randomUUID } from "node:crypto";
import { mkdir, rm, readdir, access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectState, SessionSummary } from "@lusk/shared";

class TempManager {
  readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir ??
      process.env.LUSK_TEMP_DIR ??
      join(import.meta.dirname, "../../.lusk_temp");
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  createSession(): string {
    return randomUUID();
  }

  getSessionDir(id: string): string {
    return join(this.baseDir, id);
  }

  async ensureSessionDir(id: string): Promise<string> {
    const dir = this.getSessionDir(id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async sessionExists(id: string): Promise<boolean> {
    try {
      await access(this.getSessionDir(id));
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dir = join(this.baseDir, entry.name);
      // Try lightweight meta first, fall back to full session.json
      for (const file of ["session-meta.json", "session.json"]) {
        const filePath = join(dir, file);
        try {
          const raw = await readFile(filePath, "utf-8");
          const data = JSON.parse(raw);
          const stats = await stat(filePath);
          summaries.push({
            sessionId: data.sessionId,
            state: data.state,
            videoUrl: data.videoUrl,
            videoName: data.videoName ?? null,
            createdAt: stats.mtime.toISOString(),
          });
          break;
        } catch {
          // Try next file
        }
      }
    }

    return summaries;
  }

  async restoreSession(id: string): Promise<ProjectState | null> {
    const sessionFile = join(this.getSessionDir(id), "session.json");
    try {
      const raw = await readFile(sessionFile, "utf-8");
      return JSON.parse(raw) as ProjectState;
    } catch {
      return null;
    }
  }

  async cleanupAll(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => rm(join(this.baseDir, e.name), { recursive: true, force: true }))
    );
  }
}

export const tempManager = new TempManager();
export { TempManager };
