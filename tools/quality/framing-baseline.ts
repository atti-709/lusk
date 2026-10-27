// Framing baseline on the corpus' 1080p items: solve three fixed 45 s ranges per item with track_speaker.py
// (speaker mode, independent of the caption pipeline) and draw a contact sheet per range.
//   npx tsx tools/quality/framing-baseline.ts [--only <id>[,<id>]] [--force] [--dir <path>]
// Writes ~/LuskCorpus/framing/<id>/<start>s.json (raw framing), <start>s.faces.json (every face Vision returned),
// <start>s.png (a frame every 2 s with the 9:16 crop, faces, fit ranges and cuts drawn), summary.json/.md per item
// and for the whole run. Resumable: a range with its JSON and sheet already there is skipped (--force redoes it).
// The corpus is untrusted downloaded data: it is only read by ffprobe/ffmpeg/Vision and JSON.parse.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cutsPerMinute,
  type DebugFaces,
  type DebugFrame,
  faceStats,
  type FaceStats,
  type FitRange,
  fitPercent,
  fitSeconds,
  HEIGHT_BINS,
  rangeStarts,
} from './framingStats';

const RANGE_SECONDS = 45;
const SHEET_STEP_SECONDS = 2;
const SHEET_COLUMNS = 4;
const THUMB_WIDTH = 640;
const PYTHON =
  process.env.LUSK_PYTHON ?? path.join(os.homedir(), 'Library/Application Support/@lusk/electron/python-env/venv/bin/python');
const FONT = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'].find((f) => fs.existsSync(f));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKER = path.join(HERE, '../../server/scripts/track_speaker.py');

interface Item {
  id: string;
  title: string;
  language: string;
  set: string;
  type: string[];
  videoSeconds: number | null;
  paths: { video: string | null };
}

interface Framing {
  cropWidthFraction: number;
  cuts: number[];
  keyframes: { t: number; cx: number }[];
  fit?: FitRange[];
}

export interface RangeSummary {
  id: string;
  start: number;
  duration: number;
  fitPercent: number;
  fitSeconds: number;
  fit: FitRange[];
  cuts: number[];
  cutsPerMinute: number;
  keyframes: number;
  faces: FaceStats;
  solveSeconds: number | null;
  sheet: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} failed: ${stderr.slice(-400)}`)) : resolve(stdout),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One heavy job at a time on this Mac: wait while a transcription, another tracker run or a render is going. */
async function waitForQuiet(): Promise<void> {
  for (;;) {
    const busy = await new Promise<string>((resolve) =>
      execFile('pgrep', ['-fl', 'scripts/transcribe.py|scripts/track_speaker.py|remotion render'], (_e, out) => resolve(out.trim())),
    );
    if (!busy) return;
    console.error(`  waiting: a heavy job is running (${busy.split('\n')[0].slice(0, 80)})`);
    await sleep(30_000);
  }
}

async function probeVideo(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = JSON.parse(
    await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]),
  );
  return { width: out.streams[0].width, height: out.streams[0].height, duration: Number(out.format.duration) };
}

function runTracker(video: string, start: number, duration: number, width: number, height: number, out: string, debug: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      PYTHON,
      [TRACKER, '--video', video, '--start', String(start), '--duration', String(duration), '--width', String(width), '--height', String(height),
        '--mode', 'speaker', '--ffmpeg', 'ffmpeg', '--out', out, '--debug-faces', debug],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`track_speaker.py exited ${code}: ${err.slice(-600)}`))));
  });
}

/** Crop center at `t`: linear between keyframes (a cut is two keyframes 1 ms apart), held outside them. */
export function cxAt(keyframes: { t: number; cx: number }[], t: number): number {
  if (keyframes.length === 0) return 0.5;
  if (t <= keyframes[0].t) return keyframes[0].cx;
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1];
    const b = keyframes[i];
    if (t <= b.t) return b.t === a.t ? b.cx : a.cx + ((b.cx - a.cx) * (t - a.t)) / (b.t - a.t);
  }
  return keyframes[keyframes.length - 1].cx;
}

const px = (v: number) => Math.round(v);

/** ffmpeg filter chain drawing the framing state at `t` onto a thumbnail of size w x h. */
function overlayFilter(t: number, w: number, h: number, framing: Framing, debug: DebugFaces): string {
  const f: string[] = [];
  const cx = cxAt(framing.keyframes, t);
  const fit = (framing.fit ?? []).find((r) => t >= r[0] && t < r[1]);
  const cut = framing.cuts.find((c) => c >= t - SHEET_STEP_SECONDS / 2 && c < t + SHEET_STEP_SECONDS / 2);
  const frame = debug.frames.reduce<DebugFrame | undefined>(
    (best, x) => (!best || Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best),
    undefined,
  );

  for (const x of frame?.text ?? []) {
    f.push(`drawbox=x=${px(x[0] * w)}:y=${h - 6}:w=${Math.max(2, px((x[1] - x[0]) * w))}:h=4:color=white@0.8:t=fill`);
  }
  for (const face of frame?.faces ?? []) {
    const color = face.conf < debug.faceMinConfidence ? 'gray' : face.h < debug.fitFaceMinH ? 'yellow' : 'cyan';
    f.push(`drawbox=x=${px(face.x * w)}:y=${px(face.y * h)}:w=${px(face.w * w)}:h=${px(face.h * h)}:color=${color}:t=2`);
  }
  const cropW = framing.cropWidthFraction * w;
  f.push(`drawbox=x=${px(Math.min(w - cropW, Math.max(0, cx * w - cropW / 2)))}:y=0:w=${px(cropW)}:h=${h}:color=${fit ? 'green@0.35' : 'lime'}:t=${fit ? 2 : 4}`);
  if (fit) {
    f.push(`drawbox=x=0:y=0:w=${w}:h=${h}:color=orange:t=10`);
    if (fit.length === 4) f.push(`drawbox=x=${px(fit[2] * w)}:y=0:w=${px((fit[3] - fit[2]) * w)}:h=${h}:color=magenta:t=3`);
  }
  if (cut !== undefined) f.push(`drawbox=x=0:y=0:w=${w}:h=14:color=red:t=fill`);

  const label = [`t ${t}s`, `cx ${cx.toFixed(2)}`, fit ? (fit.length === 4 ? `FIT x ${fit[2].toFixed(2)}-${fit[3].toFixed(2)}` : 'FIT') : '', cut !== undefined ? `CUT ${cut.toFixed(1)}` : '']
    .filter(Boolean)
    .join('  ');
  if (FONT) {
    f.push(`drawtext=fontfile=${FONT}:text='${label}':x=8:y=22:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`);
  }
  return f.join(',');
}

async function contactSheet(video: string, start: number, duration: number, framing: Framing, debug: DebugFaces, out: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framing-sheet-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', video, '-t', String(duration), '-vf', `fps=1/${SHEET_STEP_SECONDS},scale=${THUMB_WIDTH}:-2`, path.join(tmp, 'raw_%02d.png')]);
    const raws = fs.readdirSync(tmp).filter((n) => n.startsWith('raw_')).sort();
    if (raws.length === 0) throw new Error('no frames extracted');
    const probe = await probeVideo(path.join(tmp, raws[0]));
    for (const [i, name] of raws.entries()) {
      const t = i * SHEET_STEP_SECONDS;
      await run('ffmpeg', ['-v', 'error', '-i', path.join(tmp, name), '-vf', overlayFilter(t, probe.width, probe.height, framing, debug), path.join(tmp, name.replace('raw_', 'ov_'))]);
    }
    const rows = Math.ceil(raws.length / SHEET_COLUMNS);
    await run('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, 'ov_%02d.png'), '-vf', `tile=${SHEET_COLUMNS}x${rows}:padding=4:color=black`, '-frames:v', '1', out]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const f2 = (v: number | null) => (v === null ? '-' : v.toFixed(3));
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-');

function histogramRow(counts: number[]): string {
  const total = counts.reduce((a, b) => a + b, 0);
  return HEIGHT_BINS.map((edge, i) => `${edge}${i < HEIGHT_BINS.length - 1 ? `-${HEIGHT_BINS[i + 1]}` : '+'}: ${pct(counts[i], total)}`).join(' | ');
}

function mergeDebug(parts: DebugFaces[]): DebugFaces {
  return { ...parts[0], frames: parts.flatMap((p) => p.frames) };
}

function itemMarkdown(item: Item, ranges: RangeSummary[], faces: FaceStats): string {
  const lines = [
    `## ${item.id} (${item.language}, ${item.set}; ${item.type.join(', ')}) ${item.title}`,
    '',
    '| range | fit % | cuts/min | biggest face median (min-max) | frames no face | frames face < 0.1 | sheet |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...ranges.map(
      (r) =>
        `| ${r.start}s-${r.start + r.duration}s | ${r.fitPercent.toFixed(0)} | ${r.cutsPerMinute.toFixed(1)} | ${f2(r.faces.biggest.median)} (${f2(r.faces.biggest.min)}-${f2(r.faces.biggest.max)}) | ${pct(r.faces.framesNoFace, r.faces.frames)} | ${pct(r.faces.framesBelowFitMin, r.faces.frames)} | ${path.basename(r.sheet)} |`,
    ),
    '',
    `Biggest face per frame (fraction of frame height): min ${f2(faces.biggest.min)}, median ${f2(faces.biggest.median)}, max ${f2(faces.biggest.max)}.`,
    `Histogram of the biggest face (${faces.biggest.n} frames): ${histogramRow(faces.biggestHistogram)}`,
    `All faces (${faces.all.n}): median ${f2(faces.all.median)}; ${histogramRow(faces.allHistogram)}`,
    `Frames with no confident face: ${pct(faces.framesNoFace, faces.frames)} (${faces.framesLowConfOnly} of them with a low-confidence face); with 3+ text lines: ${pct(faces.framesTextHeavy, faces.frames)}.`,
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const root = arg('--dir') ?? path.join(os.homedir(), 'LuskCorpus');
  const force = process.argv.includes('--force');
  const only = arg('--only')?.split(',');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const items: Item[] = (manifest.items as Item[]).filter((i) => i.paths?.video && (!only || only.includes(i.id)));
  if (items.length === 0) throw new Error('no items with a video in the manifest');
  if (!FONT) console.error('warning: no system font found, labels are left out of the sheets');

  const overall: { item: Item; ranges: RangeSummary[]; faces: FaceStats; fitPercent: number; cutsPerMinute: number }[] = [];
  for (const item of items) {
    const video = item.paths.video as string;
    const outDir = path.join(root, 'framing', item.id);
    fs.mkdirSync(outDir, { recursive: true });
    const { width, height, duration } = await probeVideo(video);
    console.error(`${item.id}: ${width}x${height}, ${(duration / 60).toFixed(1)} min`);
    const ranges: RangeSummary[] = [];
    const debugs: DebugFaces[] = [];
    for (const start of rangeStarts(duration, RANGE_SECONDS)) {
      const span = Math.min(RANGE_SECONDS, duration - start);
      const base = path.join(outDir, `${start}s`);
      const framingFile = `${base}.json`;
      const debugFile = `${base}.faces.json`;
      const sheet = `${base}.png`;
      let solveSeconds: number | null = null;
      if (force || !fs.existsSync(framingFile) || !fs.existsSync(debugFile)) {
        await waitForQuiet();
        const t0 = Date.now();
        await runTracker(video, start, RANGE_SECONDS, width, height, framingFile, debugFile);
        solveSeconds = (Date.now() - t0) / 1000;
      }
      const framing: Framing = JSON.parse(fs.readFileSync(framingFile, 'utf8'));
      const debug: DebugFaces = JSON.parse(fs.readFileSync(debugFile, 'utf8'));
      if (force || solveSeconds !== null || !fs.existsSync(sheet)) await contactSheet(video, start, span, framing, debug, sheet);
      const fit = framing.fit ?? [];
      const summary: RangeSummary = {
        id: item.id,
        start,
        duration: span,
        fitPercent: fitPercent(fit, span),
        fitSeconds: fitSeconds(fit, span),
        fit,
        cuts: framing.cuts,
        cutsPerMinute: cutsPerMinute(framing.cuts, span),
        keyframes: framing.keyframes.length,
        faces: faceStats(debug),
        solveSeconds,
        sheet,
      };
      console.error(
        `  ${start}s: fit ${summary.fitPercent.toFixed(0)}%, ${summary.cutsPerMinute.toFixed(1)} cuts/min, biggest face median ${f2(summary.faces.biggest.median)}${solveSeconds ? ` (${solveSeconds.toFixed(0)} s)` : ''}`,
      );
      ranges.push(summary);
      debugs.push(debug);
    }
    const spanTotal = ranges.reduce((a, r) => a + r.duration, 0);
    const faces = faceStats(mergeDebug(debugs));
    const entry = {
      item,
      ranges,
      faces,
      fitPercent: spanTotal ? (100 * ranges.reduce((a, r) => a + r.fitSeconds, 0)) / spanTotal : 0,
      cutsPerMinute: spanTotal ? ranges.reduce((a, r) => a + r.cuts.length, 0) / (spanTotal / 60) : 0,
    };
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(entry, null, 2));
    fs.writeFileSync(path.join(outDir, 'summary.md'), itemMarkdown(item, ranges, faces));
    overall.push(entry);
  }

  const table = [
    '| item | language | type | fit % | cuts/min | biggest face median | frames no face | frames face < 0.1 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...overall.map(
      (o) =>
        `| ${o.item.id} | ${o.item.language} | ${o.item.type.join(', ')} | ${o.fitPercent.toFixed(0)} | ${o.cutsPerMinute.toFixed(1)} | ${f2(o.faces.biggest.median)} | ${pct(o.faces.framesNoFace, o.faces.frames)} | ${pct(o.faces.framesBelowFitMin, o.faces.frames)} |`,
    ),
  ];
  const fwdir = path.join(root, 'framing');
  fs.writeFileSync(path.join(fwdir, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items: overall }, null, 2));
  fs.writeFileSync(path.join(fwdir, 'summary.md'), `# Framing baseline\n\n${table.join('\n')}\n\n${overall.map((o) => itemMarkdown(o.item, o.ranges, o.faces)).join('\n')}`);
  console.error(`wrote ${path.join(fwdir, 'summary.md')}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
