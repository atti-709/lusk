import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Framing, FramingRequest } from "@lusk/shared";
import { getFFmpegPath } from "../config/ffmpeg.js";
import { pythonEnvService } from "./PythonEnvService.js";
import { tempManager } from "./TempManager.js";
import { spawnGroup, killGroup } from "./ChildProcesses.js";

type ProgressCallback = (percent: number, message: string) => void;

export interface FramingSource {
  sessionId: string;
  width: number;
  height: number;
}

/**
 * Solves the tracked 9:16 camera path for a clip range by running
 * `scripts/track_speaker.py` (Apple Vision face detection + a virtual camera operator).
 *
 * Results are cached per (mode, range, pick) in the session's `framing/` folder, so the
 * preview and the render of the same clip share one solve and reopening a clip is free.
 * Preview requests for a session supersede each other — dragging a clip edge must not
 * queue up a solve per keystroke — but never a render's.
 */
class FramingService {
  private inFlight = new Map<string, Promise<Framing>>();
  private latestPreview = new Map<string, { key: string; controller: AbortController }>();

  private cacheKey(req: FramingRequest): string {
    const pick = req.mode === "pick" && req.subjectX != null
      ? `-x${req.subjectX.toFixed(3)}-t${(req.subjectT ?? 0).toFixed(1)}`
      : "";
    // v2: solves carry `fit` (graphic stretches); v3: `fit` also covers text the crop would cut
    return `v3-${req.mode}-${Math.round(req.startMs)}-${Math.round(req.endMs)}${pick}`;
  }

  async getFraming(
    source: FramingSource,
    req: FramingRequest,
    opts: { preview?: boolean; onProgress?: ProgressCallback } = {},
  ): Promise<Framing> {
    const key = this.cacheKey(req);
    const dir = path.join(tempManager.getSessionDir(source.sessionId), "framing");
    const file = path.join(dir, `${key}.json`);

    const cached = await readFile(file, "utf-8").then((t) => JSON.parse(t) as Framing).catch(() => null);
    if (cached) return cached;

    const flightKey = `${source.sessionId}/${key}`;
    let controller: AbortController | undefined;
    if (opts.preview) {
      const previous = this.latestPreview.get(source.sessionId);
      if (previous && previous.key !== key) previous.controller.abort();
      controller = previous?.key === key ? previous.controller : new AbortController();
      this.latestPreview.set(source.sessionId, { key, controller });
    }

    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;

    const run = this.solve(source, req, dir, file, controller?.signal, opts.onProgress)
      .finally(() => {
        this.inFlight.delete(flightKey);
        const latest = this.latestPreview.get(source.sessionId);
        if (latest?.key === key) this.latestPreview.delete(source.sessionId);
      });
    this.inFlight.set(flightKey, run);
    return run;
  }

  private async solve(
    source: FramingSource,
    req: FramingRequest,
    dir: string,
    file: string,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
  ): Promise<Framing> {
    if (!pythonEnvService.isReady()) {
      throw new Error("Speaker tracking needs the Python environment — run the setup first");
    }
    await pythonEnvService.ensureUpToDate((message) => onProgress?.(0, message));
    await mkdir(dir, { recursive: true });

    const video = path.join(tempManager.getSessionDir(source.sessionId), "input.mp4");
    const partial = `${file}.partial`;
    const args = [
      "-u",
      pythonEnvService.getScriptPath("track_speaker.py"),
      "--video", video,
      "--start", (req.startMs / 1000).toFixed(3),
      "--duration", ((req.endMs - req.startMs) / 1000).toFixed(3),
      "--width", String(source.width),
      "--height", String(source.height),
      "--mode", req.mode,
      "--ffmpeg", getFFmpegPath(),
      "--out", partial,
      ...(req.mode === "pick" && req.subjectX != null
        ? ["--subject-x", req.subjectX.toFixed(4), "--subject-t", (req.subjectT ?? 0).toFixed(2)]
        : []),
    ];

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Tracking cancelled"));
      const proc = spawnGroup(pythonEnvService.getPythonPath(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      const onAbort = () => {
        killGroup(proc);
        reject(new Error("Tracking cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let stderr = "";
      proc.stderr!.on("data", (c: Buffer) => {
        const text = c.toString();
        stderr = (stderr + text).slice(-2000);
        for (const line of text.split("\n")) if (line.trim()) console.log(`[track] ${line.trim()}`);
      });
      proc.stdout!.on("data", (c: Buffer) => {
        for (const m of c.toString().matchAll(/PROGRESS (\d+)/g)) {
          onProgress?.(parseInt(m[1]), "Tracking speaker...");
        }
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return;
        if (code === 0) resolve();
        else reject(new Error(`Speaker tracking failed (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`));
      });
    }).catch(async (err) => {
      await rm(partial, { force: true });
      throw err;
    });

    const solved = JSON.parse(await readFile(partial, "utf-8")) as Pick<Framing, "cropWidthFraction" | "cuts" | "keyframes">;
    const framing: Framing = {
      version: 1,
      mode: req.mode,
      startMs: req.startMs,
      endMs: req.endMs,
      ...solved,
    };
    await writeFile(file, JSON.stringify(framing), "utf-8");
    await rm(partial, { force: true });
    return framing;
  }
}

export const framingService = new FramingService();
