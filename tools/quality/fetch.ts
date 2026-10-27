// Fetch the quality corpus into ~/LuskCorpus/<YouTube ID>/ (resumable).
//   npx tsx tools/quality/fetch.ts [--only <id>[,<id>]] [--audio-only] [--dir <path>]
// Audio (m4a + 16 kHz WAV), captions and meta for every item first, 1080p H.264 video last.
// Free disk space is re-checked before every file; the run stops when less than 10 GB would remain.
// Everything downloaded is untrusted data: it is only read by ffprobe/ffmpeg and JSON.parse, never executed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json3ToSrt } from './captions';

const YT_DLP = process.env.YT_DLP ?? (fs.existsSync('/opt/homebrew/bin/yt-dlp') ? '/opt/homebrew/bin/yt-dlp' : 'yt-dlp');
const MIN_FREE_BYTES = 10 * 1024 ** 3;
const DURATION_TOLERANCE_S = 2;
const AUDIO_FORMAT = 'bestaudio[ext=m4a]';
const VIDEO_FORMAT = 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]';
const MB = 1024 ** 2;

interface CorpusItem {
  id: string;
  title: string;
  channel: string;
  language: string;
  set: string;
  type: string[];
  minutes: number;
  video: string;
}

class StopError extends Error {}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = cmd === YT_DLP ? ['--no-update', '--no-progress', ...args] : args;
    const p = spawn(cmd, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (!opts.quiet) process.stderr.write(d);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

async function probeDuration(file: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { quiet: true });
  return parseFloat(out.trim());
}

async function probeVideo(file: string): Promise<{ codec: string; width: number; height: number; fps: number }> {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate', '-of', 'json', file],
    { quiet: true },
  );
  const s = JSON.parse(out).streams?.[0] ?? {};
  const [n, d] = String(s.r_frame_rate ?? '0/1').split('/').map(Number);
  return { codec: s.codec_name, width: s.width, height: s.height, fps: d ? Math.round(((n ?? 0) / d) * 100) / 100 : 0 };
}

function freeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Throws StopError when `needBytes` more would leave less than 10 GB free. */
function checkSpace(dir: string, needBytes: number, what: string): void {
  const free = freeBytes(dir);
  if (free - needBytes < MIN_FREE_BYTES) {
    throw new StopError(
      `stopping before ${what}: ${(free / 1024 ** 3).toFixed(1)} GB free, ~${(needBytes / 1024 ** 3).toFixed(2)} GB needed, 10 GB must remain`,
    );
  }
}

const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

async function durationOk(file: string, expected: number): Promise<boolean> {
  if (size(file) === 0) return false;
  try {
    return Math.abs((await probeDuration(file)) - expected) <= DURATION_TOLERANCE_S;
  } catch {
    return false;
  }
}

interface ChosenFormat {
  format_id: string;
  ext: string;
  vcodec: string;
  acodec: string;
  height: number | null;
  fps: number | null;
  filesize: number | null;
}

async function ytInfo(id: string, format: string): Promise<Record<string, unknown>> {
  const out = await run(YT_DLP, ['-j', '--no-playlist', '--skip-download', '-f', format, `https://www.youtube.com/watch?v=${id}`], { quiet: true });
  return JSON.parse(out);
}

function chosen(info: Record<string, unknown>): ChosenFormat[] {
  const fmts = (info.requested_formats as Record<string, unknown>[] | undefined) ?? [info];
  return fmts.map((f) => ({
    format_id: String(f.format_id),
    ext: String(f.ext),
    vcodec: String(f.vcodec),
    acodec: String(f.acodec),
    height: (f.height as number) ?? null,
    fps: (f.fps as number) ?? null,
    filesize: ((f.filesize ?? f.filesize_approx) as number) ?? null,
  }));
}

async function fetchItem(it: CorpusItem, dir: string, phase: 'audio' | 'video', root: string): Promise<Record<string, unknown>> {
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${it.id}`;
  const metaFile = path.join(dir, 'meta.json');
  const m4a = path.join(dir, 'audio.m4a');
  const wav = path.join(dir, 'audio.wav');
  const mp4 = path.join(dir, 'video.mp4');
  const srt = path.join(dir, 'youtube_auto.srt');
  const json3 = path.join(dir, 'youtube_auto.json3');

  let meta: Record<string, unknown> = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};

  if (phase === 'audio') {
    if (!meta.id) {
      const info = await ytInfo(it.id, AUDIO_FORMAT);
      meta = {
        id: info.id,
        title: info.title,
        channel: info.channel,
        duration: info.duration,
        upload_date: info.upload_date,
        formats: { audio: chosen(info) },
      };
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
    }
    const duration = Number(meta.duration);

    if (!(await durationOk(m4a, duration))) {
      checkSpace(root, it.minutes * 1.3 * MB + 50 * MB, `${it.id}/audio.m4a`);
      fs.rmSync(m4a, { force: true });
      await run(YT_DLP, ['--no-playlist', '-f', AUDIO_FORMAT, '-o', m4a, url]);
      if (!(await durationOk(m4a, duration))) throw new Error(`${it.id}: audio.m4a duration differs from ${duration}s`);
    }
    const m4aDur = await probeDuration(m4a);

    if (!(await durationOk(wav, m4aDur))) {
      checkSpace(root, it.minutes * 2 * MB + 50 * MB, `${it.id}/audio.wav`);
      const tmp = path.join(dir, 'audio.partial.wav');
      await run('ffmpeg', ['-y', '-v', 'error', '-i', m4a, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp]);
      if (!(await durationOk(tmp, m4aDur))) throw new Error(`${it.id}: audio.wav length differs from audio.m4a by more than ${DURATION_TOLERANCE_S}s`);
      fs.renameSync(tmp, wav);
    }

    if (!fs.existsSync(srt) || !fs.existsSync(json3)) {
      checkSpace(root, 50 * MB, `${it.id}/captions`);
      const tmpDir = fs.mkdtempSync(path.join(dir, '.subs-'));
      try {
        await run(YT_DLP, [
          '--no-playlist', '--skip-download', '--write-auto-subs', '--sub-format', 'json3', '--sub-langs', 'sk-orig,cs-orig',
          '-o', path.join(tmpDir, 'youtube_auto.%(ext)s'), url,
        ]);
        const found = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json3'));
        const pick = found.find((f) => f.includes(`.${it.language}-orig.`)) ?? found[0];
        if (pick) {
          fs.copyFileSync(path.join(tmpDir, pick), json3);
          const { srt: text, cues, words } = json3ToSrt(JSON.parse(fs.readFileSync(json3, 'utf8')));
          fs.writeFileSync(srt, text);
          meta.captions = { lang: pick.split('.')[1], words, cues: cues.length };
        } else {
          meta.captions = null;
          console.warn(`${it.id}: no sk-orig/cs-orig auto-captions`);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
    }
  } else if (it.video === '1080p') {
    const duration = Number(meta.duration);
    if (!(await durationOk(mp4, duration))) {
      const info = await ytInfo(it.id, VIDEO_FORMAT);
      const fmts = chosen(info);
      const est = Math.max(fmts.reduce((a, f) => a + (f.filesize ?? 0), 0), it.minutes * 30 * MB);
      checkSpace(root, est * 1.15, `${it.id}/video.mp4`);
      fs.rmSync(mp4, { force: true });
      await run(YT_DLP, ['--no-playlist', '-f', VIDEO_FORMAT, '--merge-output-format', 'mp4', '-o', mp4, url]);
      if (!(await durationOk(mp4, duration))) throw new Error(`${it.id}: video.mp4 duration differs from ${duration}s`);
      const v = await probeVideo(mp4);
      if (v.codec !== 'h264') throw new Error(`${it.id}: video.mp4 is ${v.codec}, expected h264`);
      (meta.formats as Record<string, unknown>).video = fmts;
      meta.video = v;
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
    }
  }
  return meta;
}

async function entry(it: CorpusItem, dir: string): Promise<Record<string, unknown>> {
  const rel = (f: string) => (fs.existsSync(path.join(dir, f)) ? path.join(dir, f) : null);
  const metaFile = path.join(dir, 'meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const m4a = rel('audio.m4a');
  const wav = rel('audio.wav');
  const mp4 = rel('video.mp4');
  return {
    id: it.id,
    title: it.title,
    channel: it.channel,
    language: it.language,
    set: it.set,
    type: it.type,
    minutes: it.minutes,
    wantsVideo: it.video === '1080p',
    durationSeconds: meta.duration ?? null,
    audioM4aSeconds: m4a ? await probeDuration(m4a) : null,
    audioWavSeconds: wav ? await probeDuration(wav) : null,
    videoSeconds: mp4 ? await probeDuration(mp4) : null,
    video: meta.video ?? null,
    captions: meta.captions ?? null,
    paths: { dir, audioM4a: m4a, audioWav: wav, video: mp4, captionsSrt: rel('youtube_auto.srt'), captionsJson3: rel('youtube_auto.json3'), meta: rel('meta.json') },
    bytes: ['audio.m4a', 'audio.wav', 'video.mp4', 'youtube_auto.srt', 'youtube_auto.json3'].reduce((a, f) => a + size(path.join(dir, f)), 0),
  };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8')) as { items: CorpusItem[] };
  const root = arg('--dir') ?? path.join(os.homedir(), 'LuskCorpus');
  const only = arg('--only')?.split(',');
  const items = corpus.items.filter((i) => i.set !== 'excluded' && (!only || only.includes(i.id)));
  fs.mkdirSync(root, { recursive: true });

  const errors: string[] = [];
  let stopped: string | null = null;
  const phases: ('audio' | 'video')[] = process.argv.includes('--audio-only') ? ['audio'] : ['audio', 'video'];
  try {
    for (const phase of phases) {
      for (const it of items) {
        try {
          console.log(`[${phase}] ${it.id} ${it.title}`);
          await fetchItem(it, path.join(root, it.id), phase, root);
        } catch (e) {
          if (e instanceof StopError) throw e;
          errors.push(`${it.id} (${phase}): ${(e as Error).message}`);
          console.error(`ERROR ${errors[errors.length - 1]}`);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof StopError)) throw e;
    stopped = e.message;
    console.error(stopped);
  }

  const entries = [];
  for (const it of items) entries.push(await entry(it, path.join(root, it.id)));
  const manifest = {
    generatedAt: new Date().toISOString(),
    root,
    freeGbAfter: Math.round((freeBytes(root) / 1024 ** 3) * 10) / 10,
    totalBytes: entries.reduce((a, e) => a + (e.bytes as number), 0),
    stopped,
    errors,
    items: entries,
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: ${entries.length} items, ${(manifest.totalBytes / 1024 ** 3).toFixed(2)} GB, ${errors.length} errors${stopped ? ', STOPPED' : ''}`);
  if (stopped) process.exit(2);
  if (errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
