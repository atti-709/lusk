import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Long-running helper processes (WhisperX, speaker tracking) each run as the leader of
 * their own process group, so stopping one takes down everything it started too — the
 * ffmpeg a Python script reads frames from would otherwise outlive it. Every live group
 * is tracked here so a server shutdown can stop them all: Node does not kill its
 * children when it exits, and a quit mid-transcription used to leave WhisperX running.
 */

const live = new Set<ChildProcess>();

/** How long a group gets to exit on SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 3000;

export function spawnGroup(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const proc = spawn(command, args, { ...options, detached: true });
  live.add(proc);
  proc.once("exit", () => live.delete(proc));
  proc.once("error", () => live.delete(proc));
  return proc;
}

/** Signal the process's whole group; falls back to the process alone if the group is gone. */
function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid == null) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

/** SIGTERM the process group, then SIGKILL whatever is still alive after a grace period. */
export function killGroup(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    // The leader is gone, but children it left behind may still hold the group
    signalGroup(proc, "SIGKILL");
    return;
  }
  signalGroup(proc, "SIGTERM");
  const timer = setTimeout(() => signalGroup(proc, "SIGKILL"), KILL_GRACE_MS);
  timer.unref();
  proc.once("exit", () => {
    clearTimeout(timer);
    // Stragglers that ignored SIGTERM die with the group
    signalGroup(proc, "SIGKILL");
  });
}

/** Stop every tracked group immediately — used on server shutdown. */
export function killAllGroups(): void {
  for (const proc of live) signalGroup(proc, "SIGKILL");
  live.clear();
}
