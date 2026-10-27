// A lock file shared by the heavy corpus/episode jobs: only one MLX/Python pipeline may run on this Mac.
// The file holds the owner's pid and start time; a lock whose pid is gone is stale and taken over.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCK = path.join(os.homedir(), 'LuskCorpus', '.lock');

export interface LockInfo {
  pid: number;
  startedAt: string;
  tool: string;
}

export class LockHeldError extends Error {
  constructor(
    readonly file: string,
    readonly holder: LockInfo,
  ) {
    super(`${file} is held by ${holder.tool} (pid ${holder.pid}, since ${holder.startedAt}): only one heavy job may run at a time`);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<LockInfo>;
    return typeof info.pid === 'number' ? { pid: info.pid, startedAt: String(info.startedAt ?? ''), tool: String(info.tool ?? '?') } : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock, or throws LockHeldError while another live process holds it. Returns the release
 * function (only removes the file if it is still ours). `file` is a parameter for tests.
 */
export function acquireLock(tool: string, file: string = DEFAULT_LOCK): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), tool };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' makes creation atomic: two starts at once cannot both succeed
      fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      return () => {
        if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readLock(file);
    if (holder && pidAlive(holder.pid)) throw new LockHeldError(file, holder);
    fs.rmSync(file, { force: true }); // stale (dead pid) or unreadable
  }
  throw new Error(`could not take ${file}`);
}
