import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, LockHeldError } from './lock';
import { isValidVersion } from './version';

const dirs: string[] = [];
function lockFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lusk-lock-'));
  dirs.push(dir);
  return path.join(dir, '.lock');
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('writes pid and start time, and releases', () => {
    const file = lockFile();
    const release = acquireLock('test', file);
    const info = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(info.pid).toBe(process.pid);
    expect(info.tool).toBe('test');
    expect(Date.parse(info.startedAt)).not.toBeNaN();
    release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses while a live process holds it', () => {
    const file = lockFile();
    const release = acquireLock('first', file);
    expect(() => acquireLock('second', file)).toThrow(LockHeldError);
    release();
    acquireLock('third', file)();
  });

  it('takes over a lock whose pid is gone', () => {
    const file = lockFile();
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-01-01T00:00:00Z', tool: 'dead' }));
    const release = acquireLock('new', file);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).tool).toBe('new');
    release();
  });

  it('takes over an unreadable lock file', () => {
    const file = lockFile();
    fs.writeFileSync(file, 'garbage');
    acquireLock('new', file)();
  });

  it('does not remove a lock that became someone else\'s', () => {
    const file = lockFile();
    const release = acquireLock('mine', file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: 'x', tool: 'other' }));
    release();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('isValidVersion', () => {
  it('accepts <nn>-<tag>', () => {
    for (const v of ['01-v0', '02-cs-large-v3', '00-smoke', '10-a']) expect(isValidVersion(v)).toBe(true);
  });
  it('rejects bare or malformed names', () => {
    for (const v of ['v1', '1-v0', '001-v0', '01-', '01-V0', '01-v0/../x', '01_v0', '', '01-v0 ', '../01-v0']) expect(isValidVersion(v)).toBe(false);
  });
});
