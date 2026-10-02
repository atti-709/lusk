import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { getFFmpegPath } from "../config/ffmpeg.js";

const execFileAsync = promisify(execFile);

/**
 * Whether the app's Chromium can play a source directly, and a playable copy when not.
 *
 * Everything server-side reads the source through ffmpeg, which decodes anything — but
 * the preview Player and the clip cards are plain <video> elements. Chromium handles
 * the delivery codecs in any common container (an OBS .mkv of H.264/AAC plays as is,
 * as does PCM audio in a .mov), but not editing codecs: a ProRes or DNxHD master loads
 * as a black 0x0 picture with sound. Those sources get an H.264 copy, encoded on the
 * VideoToolbox hardware encoder; everything else stays a zero-cost symlink.
 */

/** Video codecs Chromium on macOS decodes (ffmpeg's codec names). */
const PLAYABLE_VIDEO = new Set(["h264", "hevc", "vp8", "vp9", "av1"]);
/** Audio codecs it decodes; anything else is converted to AAC. */
const PLAYABLE_AUDIO = /^(aac|mp3|opus|vorbis|flac|pcm_(s16|s24|s32|f32)(le|be)?)$/;
/** Audio an .mp4 copy can carry as is (PCM plays in a .mov, but MP4 has no tag for it). */
const MP4_AUDIO = new Set(["aac", "mp3"]);

/** Bitrate for a re-encoded copy — generous, since clips are cut from it at full quality. */
const COPY_VIDEO_BITRATE = "30M";

export interface SourceCodecs {
  video: string | null;
  audio: string | null;
  durationSec: number | null;
}

/** Read the first video and audio stream's codec from `ffmpeg -i` (the bundle has no ffprobe). */
export async function probeCodecs(filePath: string): Promise<SourceCodecs> {
  const result = await execFileAsync(getFFmpegPath(), ["-hide_banner", "-i", filePath])
    .catch((e: { stderr?: string }) => e);
  const text = (result as { stderr?: string }).stderr ?? "";
  const video = /Stream #\d+:\d+[^\n]*?: Video: ([\w-]+)/.exec(text)?.[1] ?? null;
  const audio = /Stream #\d+:\d+[^\n]*?: Audio: ([\w-]+)/.exec(text)?.[1] ?? null;
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  const durationSec = d ? parseInt(d[1]) * 3600 + parseInt(d[2]) * 60 + parseFloat(d[3]) : null;
  return { video, audio, durationSec };
}

export interface PlayablePlan {
  /** True when the source plays as is. */
  direct: boolean;
  /** ffmpeg codec args for the copy (only when !direct). */
  videoArgs: string[];
  audioArgs: string[];
}

export function planPlayable(codecs: SourceCodecs): PlayablePlan {
  const videoOk = codecs.video != null && PLAYABLE_VIDEO.has(codecs.video);
  const audioOk = codecs.audio == null || PLAYABLE_AUDIO.test(codecs.audio);
  // An unreadable probe (null video) is left alone: ffmpeg will report the real problem
  if (codecs.video == null || (videoOk && audioOk)) {
    return { direct: true, videoArgs: [], audioArgs: [] };
  }
  return {
    direct: false,
    videoArgs: videoOk
      ? ["-c:v", "copy"]
      : ["-c:v", "h264_videotoolbox", "-b:v", COPY_VIDEO_BITRATE, "-pix_fmt", "yuv420p"],
    audioArgs: codecs.audio != null && MP4_AUDIO.has(codecs.audio)
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "256k"],
  };
}

interface CopyStamp {
  source: string;
  size: number;
  mtimeMs: number;
}

/**
 * Write a browser-playable copy of `source` to `target`, unless one made from this exact
 * source file is already there. Progress is 0-100 over the source duration.
 */
export async function makePlayableCopy(
  source: string,
  target: string,
  plan: PlayablePlan,
  durationSec: number | null,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const stampPath = `${target}.source.json`;
  const { size, mtimeMs } = await stat(source);
  try {
    const stamp = JSON.parse(await readFile(stampPath, "utf-8")) as CopyStamp;
    await stat(target);
    if (stamp.source === source && stamp.size === size && stamp.mtimeMs === mtimeMs) return;
  } catch { /* no usable copy yet */ }

  const partial = `${target}.partial.mp4`;
  await rm(target, { force: true });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), [
      "-v", "error", "-y", "-progress", "pipe:1", "-nostats",
      "-i", source,
      "-map", "0:v:0", "-map", "0:a:0?",
      ...plan.videoArgs, ...plan.audioArgs,
      "-movflags", "+faststart",
      partial,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-1000); });
    proc.stdout.on("data", (c: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(c.toString());
      if (m && durationSec) onProgress?.(Math.min(99, (parseInt(m[1]) / 1e6 / durationSec) * 100));
    });
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Could not make a playable copy: ${stderr.trim()}`)));
  }).catch(async (err) => {
    await rm(partial, { force: true });
    throw err;
  });
  await rename(partial, target);
  await writeFile(stampPath, JSON.stringify({ source, size, mtimeMs } satisfies CopyStamp));
}
