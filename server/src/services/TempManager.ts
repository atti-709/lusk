import { mkdir, rm, readdir, access } from "node:fs/promises";
import { join } from "node:path";

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

  async cleanupSessionCache(id: string): Promise<void> {
    const cacheDir = join(this.getSessionDir(id), "chunk_cache");
    try {
      await rm(cacheDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  async cleanupSession(id: string): Promise<void> {
    const dir = this.getSessionDir(id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /**
   * Remove temp directories that are not in the given set of known project IDs.
   */
  async cleanupOrphaned(knownIds: Set<string>): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !knownIds.has(e.name))
        .map((e) => rm(join(this.baseDir, e.name), { recursive: true, force: true }))
    );
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
