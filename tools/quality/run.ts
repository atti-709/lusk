// Run the app pipeline on corpus items and store a versioned result under ~/LuskCorpus/runs/<version>/<item>/.
//   npx tsx tools/quality/run.ts <version> <item…> [--manifest <path>] [--video] [--dir <corpus dir>]
// <version> is `<nn>-<tag>` (01-v0, 02-cs-large-v3). Needs `npm run build:electron` first and a free Mac:
// only one heavy job may run at a time (a lock file in the corpus dir enforces it).
//
// Per item: a fresh headless app (LUSK_HEADLESS) with an explicit per-run profile and config.json (Gemini key
// from the real config, translateToEnglish false, the item's language, no prompt overrides) → a project in the
// item's language → transcribe → script correction (only when the item has a script) → proofread → clips,
// from a black proxy video carrying the item's WAV (or from video.mp4 with --video, for framing). The SRT is
// fetched right after READY. Finished items (meta.json completed) are skipped, so re-running resumes.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchLusk, type HeadlessLusk } from '../../electron/e2e/harness';
import { acquireLock, LockHeldError } from './lock';
import { isValidVersion } from './version';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG = path.join(os.homedir(), 'Library', 'Application Support', '@lusk', 'electron', 'config.json');
const json = { 'Content-Type': 'application/json' };
/** The app of the item being run, so an interrupt can stop it and its Python helper. */
let current: HeadlessLusk | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One thing to run. Corpus items get wav/video from their folder; a manifest item can name its own paths. */
export interface RunItem {
  id: string;
  language: string;
  set: string;
  wav: string;
  video: string | null;
  script: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Items from a manifest JSON: `{ "items": [{ id, language, set?, wav?, video?, script? }] }`. Relative paths
 * resolve against the manifest's folder (`wav` and `video` default to <corpusDir>/<id>/audio.wav / video.mp4).
 */
export function loadItems(manifestPath: string, corpusDir: string): RunItem[] {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { items: Record<string, unknown>[] };
  const base = path.dirname(manifestPath);
  const resolve = (p: unknown) => (typeof p === 'string' && p ? path.resolve(base, expandHome(p)) : null);
  return manifest.items.map((raw) => {
    const id = String(raw.id);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad item id in ${manifestPath}: ${id}`);
    const own = resolve(raw.video);
    const corpusVideo = path.join(corpusDir, id, 'video.mp4');
    return {
      id,
      language: String(raw.language),
      set: String(raw.set ?? ''),
      wav: resolve(raw.wav) ?? path.join(corpusDir, id, 'audio.wav'),
      video: own ?? (raw.video === undefined && fs.existsSync(corpusVideo) ? corpusVideo : null),
      script: resolve(raw.script),
    };
  });
}

function ffprobeSeconds(file: string): number {
  return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
}

/** Source of the Whisper/Gemini model names: the constants in the services, read as text so they cannot drift. */
function modelNames(language: string): Record<string, string | null> {
  const whisper = fs.readFileSync(path.join(REPO, 'server/src/services/WhisperService.ts'), 'utf-8');
  const gemini = fs.readFileSync(path.join(REPO, 'server/src/services/GeminiService.ts'), 'utf-8');
  const base = whisper.match(/const WHISPERX_MODEL = "([^"]+)"/)?.[1] ?? null;
  const perLanguage = whisper.match(/LANGUAGE_MODELS: Record<string, string> = \{([^}]*)\}/)?.[1] ?? '';
  const own = new RegExp(`\\b${language}: "([^"]+)"`).exec(perLanguage)?.[1] ?? null;
  return {
    whisper: process.env.LUSK_WHISPER_MODEL || own || base,
    whisperOverride: process.env.LUSK_WHISPER_MODEL || null,
    geminiFlashLite: gemini.match(/^const MODEL = "([^"]+)"/m)?.[1] ?? null, // correction, translation, proofread
    geminiReasoning: gemini.match(/^const REASONING_MODEL = "([^"]+)"/m)?.[1] ?? null, // clips
  };
}

function gitInfo(): { commit: string; dirty: boolean } {
  const run = (...a: string[]) => spawnSync('/usr/bin/git', ['-C', REPO, ...a], { encoding: 'utf-8' }).stdout.trim();
  return { commit: run('rev-parse', 'HEAD'), dirty: run('status', '--porcelain', '--', 'server', 'shared', 'client', 'electron/src').length > 0 };
}

/** Peak resident memory (KB) of the Python helper, sampled from `ps` while the pipeline runs. */
function startRssSampler(): { stop(): number } {
  let peakKb = 0;
  const sample = () => {
    const out = spawnSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf-8', maxBuffer: 1 << 26 }).stdout;
    // all processes of the helper together (a worker pool is part of the same job)
    let sum = 0;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && /scripts\/transcribe\.py/.test(m[2])) sum += Number(m[1]);
    }
    peakKb = Math.max(peakKb, sum);
  };
  const timer = setInterval(sample, 2000);
  return { stop: () => (clearInterval(timer), sample(), peakKb) };
}

async function runItem(item: RunItem, versionDir: string, useVideo: boolean, corpusDir: string): Promise<void> {
  const outDir = path.join(versionDir, item.id);
  const metaPath = path.join(outDir, 'meta.json');
  if (fs.existsSync(metaPath) && JSON.parse(fs.readFileSync(metaPath, 'utf-8')).completed === true) {
    console.log(`${item.id}: already completed, skipped`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const logLines: string[] = [];
  const log = (m: string) => {
    const l = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${m}`;
    console.log(l);
    logLines.push(l);
  };

  if (!fs.existsSync(item.wav)) throw new Error(`no audio: ${item.wav}`);
  if (useVideo && !item.video) throw new Error(`${item.id} has no video (--video)`);
  const wavSec = ffprobeSeconds(item.wav);
  const expected = fs.existsSync(path.join(corpusDir, 'manifest.json'))
    ? (JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf-8')).items as { id: string; durationSeconds?: number }[]).find((i) => i.id === item.id)?.durationSeconds
    : undefined;
  if (expected && Math.abs(wavSec - expected) > 2) throw new Error(`audio is ${wavSec.toFixed(0)} s but the manifest says ${expected.toFixed(0)} s`);

  const profile = path.join(versionDir, '.profile');
  const workDir = path.join(profile, 'work', item.id);
  fs.rmSync(workDir, { recursive: true, force: true }); // a partial earlier attempt starts clean
  fs.mkdirSync(workDir, { recursive: true });
  let source: string;
  if (useVideo) {
    source = item.video!;
  } else {
    source = path.join(workDir, `${item.id}.mov`);
    // exactly the audio's length: with -shortest, x264's lookahead overshoots
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x36:r=5', '-i', item.wav,
      '-t', String(wavSec), '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'pcm_s16le', '-y', source]);
  }

  // The config this run uses, written fresh for every item: the key from the real config, nothing else
  // (no prompt overrides), so a run never depends on what the owner's settings happen to hold
  const key = process.env.GEMINI_API_KEY ? undefined : (JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf-8')).geminiApiKey as string | undefined);
  if (!key && !process.env.GEMINI_API_KEY) throw new Error(`no Gemini API key in ${REAL_CONFIG} or GEMINI_API_KEY`);
  const settings = { transcriptionLanguage: item.language, translateToEnglish: false };
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ ...(key ? { geminiApiKey: key } : {}), ...settings }, null, 2), { mode: 0o600 });

  const meta: Record<string, unknown> = {
    completed: false,
    version: path.basename(versionDir),
    item: { id: item.id, language: item.language, set: item.set },
    git: gitInfo(),
    startedAt: new Date().toISOString(),
    settings: { ...settings, promptOverrides: false },
    source: useVideo ? 'video' : 'black proxy + wav',
    script: item.script ? path.basename(item.script) : null,
    audioSeconds: Math.round(wavSec * 10) / 10,
    models: modelNames(item.language),
  };
  const saveMeta = () => fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  saveMeta();

  const t0 = Date.now();
  const lusk: HeadlessLusk = await launchLusk({ userDataDir: profile, seedConfig: false, headless: true });
  current = lusk;
  const rss = startRssSampler();
  let peakKb = 0;
  try {
    log(`${item.id} start (${item.language}, ${(wavSec / 60).toFixed(1)} min${item.script ? `, script ${path.basename(item.script)}` : ''})`);
    const { projectId } = await lusk.api<{ projectId: string }>('/api/projects/create', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ projectPath: path.join(workDir, `${item.id}.lusk`), language: item.language }),
    });
    await lusk.api(`/api/projects/${projectId}/select-video`, { method: 'POST', headers: json, body: JSON.stringify({ videoPath: source }) });
    if (item.script) {
      // before transcription, as the episode batch does: the script correction is the production path
      await lusk.api(`/api/projects/${projectId}/script`, { method: 'POST', headers: json, body: JSON.stringify({ scriptText: fs.readFileSync(item.script, 'utf-8') }) });
    }
    const t1 = Date.now();
    await lusk.api('/api/transcribe', { method: 'POST', headers: json, body: JSON.stringify({ sessionId: projectId }) });

    let last = '';
    let alignAt: number | null = null;
    let s: any;
    for (;;) {
      s = await lusk.api<any>(`/api/projects/${projectId}`);
      const key = `${s.state} ${String(s.message).replace(/\d+%|\(.*?\)|\.\.\.$/g, '').trim()}`;
      if (key !== last) {
        log(`  ${s.state} ${s.progress}% ${s.message}`);
        last = key;
      }
      if (s.state === 'ALIGNING' && alignAt === null) alignAt = Date.now();
      if (s.state === 'READY') break;
      if (s.progress === -1) throw new Error(s.message);
      if (s.state === 'ALIGNING' && s.progress === 100 && /fail|manual|cancel|No Gemini/i.test(s.message)) throw new Error(s.message);
      await sleep(1000);
    }
    const t2 = Date.now();
    peakKb = rss.stop();

    // Language is per project now, but export right after READY anyway: nothing later can change it
    const res = await fetch(`${lusk.baseUrl}/api/projects/${projectId}/captions.srt`);
    if (!res.ok) throw new Error(`captions.srt unavailable (${res.status})`);
    fs.writeFileSync(path.join(outDir, `captions_${item.language}.srt`), await res.text());
    fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify(s.transcript, null, 1));
    // the heard words before correction/proofread: what the text passes changed is the diff of the two
    fs.writeFileSync(path.join(outDir, 'transcript_raw.json'), JSON.stringify(s.originalTranscript, null, 1));
    fs.writeFileSync(path.join(outDir, 'clips.json'), JSON.stringify(s.viralClips ?? [], null, 1));

    const report = s.runReport ?? null;
    const passesOk = !!report && !report.failed && report.proofread?.status === 'ok' && report.clips?.status === 'ok' && report.translation?.status !== 'failed';
    Object.assign(meta, {
      completed: true,
      finishedAt: new Date().toISOString(),
      timingsSeconds: {
        transcribe: Math.round(((alignAt ?? t2) - t1) / 1000),
        gemini: Math.round((t2 - (alignAt ?? t2)) / 1000),
        total: Math.round((t2 - t0) / 1000),
      },
      peakRssPythonMb: Math.round(peakKb / 1024),
      passes: {
        correction: report?.correction ?? null,
        proofread: report?.proofread ?? null,
        clips: report?.clips ?? null,
        translation: report?.translation ?? null,
        failed: report?.failed ?? null,
      },
      // false: a pass failed silently (the project still reached READY); do not compare this run as a version
      passesOk,
      counts: { words: s.transcript?.words?.length ?? 0, clips: (s.viralClips ?? []).length },
    });
    log(`${item.id} done in ${Math.round((t2 - t0) / 60000)} min${passesOk ? '' : ' — A PASS FAILED, see meta.json passes'}`);
  } catch (err) {
    meta.error = err instanceof Error ? err.message : String(err);
    log(`${item.id} FAILED: ${meta.error}`);
    throw err;
  } finally {
    if (!peakKb) peakKb = rss.stop();
    if (meta.completed !== true) meta.peakRssPythonMb = Math.round(peakKb / 1024);
    saveMeta();
    fs.writeFileSync(path.join(outDir, 'log.txt'), logLines.join('\n') + '\n\n--- app/server output ---\n' + lusk.logs.join(''));
    await lusk.close();
    current = null;
    if (!useVideo) fs.rmSync(path.join(workDir, `${item.id}.mov`), { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = ['--manifest', '--dir'];
  const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
  const [version, ...ids] = positional;
  if (!version || !ids.length || !isValidVersion(version)) {
    console.error('usage: tsx tools/quality/run.ts <nn>-<tag> <item…> [--manifest <path>] [--video] [--dir <corpus dir>]\n' +
      '  <version> must look like 01-v0 or 02-cs-large-v3');
    process.exit(2);
  }
  const corpusDir = path.resolve(expandHome(arg('--dir') ?? '~/LuskCorpus'));
  const manifest = arg('--manifest') ? path.resolve(arg('--manifest')!) : path.join(REPO, 'tools/quality/corpus.json');
  const known = new Map(loadItems(manifest, corpusDir).map((i) => [i.id, i]));
  const items = ids.map((id) => {
    const item = known.get(id);
    if (!item) throw new Error(`${id} is not in ${manifest}`);
    return item;
  });
  if (!fs.existsSync(path.join(REPO, 'electron/dist/main.js'))) throw new Error('electron/dist/main.js missing — run `npm run build:electron` first');

  let release: () => void;
  try {
    release = acquireLock('quality/run.ts', path.join(corpusDir, '.lock'));
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(err.message);
      process.exit(3);
    }
    throw err;
  }
  const cleanup = () => release();
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void (current?.close() ?? Promise.resolve()).finally(() => process.exit(130)));

  const versionDir = path.join(corpusDir, 'runs', version);
  fs.mkdirSync(versionDir, { recursive: true });
  let failed = 0;
  for (const item of items) {
    try {
      await runItem(item, versionDir, process.argv.includes('--video'), corpusDir);
    } catch (err) {
      failed++;
      console.error(`${item.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`${version}: ${items.length - failed} ok, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// Run only when started directly, so the helpers can be imported
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
