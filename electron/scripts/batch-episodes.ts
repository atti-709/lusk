/**
 * Batch-produce Lusk shorts and full-episode subtitles for every episode that lacks them.
 *
 *   npm run batch:episodes -- --dry-run         # see the plan: sources, scripts, what's missing
 *   caffeinate -i npm run batch:episodes        # run it (keeps the Mac awake)
 *
 * (`batch:episodes` rebuilds the app first; from electron/ the script alone is
 * `npx tsx scripts/batch-episodes.ts`.)
 *
 * For each episode folder (`E## Title/`) it decides what is missing:
 *   - subtitles: `E##_captions_sk.srt` / `E##_captions_en.srt` at the episode root
 *   - shorts:    a `SHORTS/LUSK*` folder with at least one .mp4 — and an episode missing
 *                either subtitle file gets new shorts even if such a folder exists
 * and runs the real app (via the Playwright harness, isolated profile) on the episode's
 * source: transcribe → script correction (if a .md exists) → proofread → clips →
 * translation → render every clip at 1080×1920 with speaker tracking. Outputs go to:
 *   - `SHORTS/LUSK<n>/<title>.mp4` (next free n; never into an existing folder)
 *   - `E##_captions_{sk,en}.srt` (only the missing ones; nothing is overwritten)
 *   - `PROJECT/LUSK/E##_auto.lusk` (the project, to open and tweak in the Studio)
 *
 * Disk: the SSD can't hold every source at once. Episodes run one at a time; a run checks
 * free space first, and after each episode the source's local copy is evicted from the
 * Google Drive cache (it stays in the cloud) along with uploaded outputs of earlier
 * episodes. Renders are staged in the work dir and deleted once copied.
 *
 * Resumable: stop it any time with Ctrl+C (Lusk closes cleanly) and run the same command
 * again. Finished episodes are skipped (their outputs exist); the interrupted one picks up
 * where it stopped — the half-done `E##_auto.lusk` is reopened (an interrupted transcription
 * restarts, Gemini steps reuse their cache), shorts already rendered are kept in the work
 * dir, and a half-finished upload continues into the same LUSK<n> folder. What an episode
 * needs is fixed in `<work>/E##/plan.json` when it starts, so its own partial outputs never
 * make it look done.
 *
 * Options:
 *   --episodes <dir>   EPISODES folder (default: the Svätonázor shared drive)
 *   --work <dir>       staging/log dir (default: ~/LuskBatch)
 *   --only E01,E07     restrict to these episodes     --from E10   start at this episode
 *   --overrides <json> {"E47": "E46.mp4"} — force a source file per episode
 *   --min-free-gb <n>  stop when free space drops below source size + n GB (default 6)
 *   --no-evict         keep downloaded sources on disk
 *   --dry-run          print the plan only
 */
import { launchLusk, type Lusk } from "../e2e/harness";
import { execFileSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ── Options ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);

const EPISODES = opt("episodes") ??
  path.join(homedir(), "Library/CloudStorage/GoogleDrive-xzsiros@gmail.com/Shared drives/Svätonázor/EPISODES");
const WORK = opt("work") ?? path.join(homedir(), "LuskBatch");
const ONLY = opt("only")?.split(",").map((s) => s.trim().toUpperCase());
const FROM = opt("from")?.toUpperCase();
const OVERRIDES: Record<string, string> = opt("overrides") ? JSON.parse(readFileSync(opt("overrides")!, "utf-8")) : {};
const MIN_FREE_GB = Number(opt("min-free-gb") ?? 6);
const EVICT = !flag("no-evict");
const DRY = flag("dry-run");

const REPO = path.resolve(__dirname, "../..");
const FFMPEG = path.join(REPO, "node_modules/ffmpeg-static/ffmpeg");
const json = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync(WORK, { recursive: true });
const LOG = path.join(WORK, "batch.log");
const STATE = path.join(WORK, "state.json");
function log(msg: string) {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  const line = `[${local.toISOString().slice(0, 19).replace("T", " ")}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}
type EpisodeState = { status: "done" | "failed" | "skipped"; at: string; detail?: string };
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf-8")) : {};
const state: Record<string, EpisodeState> = saved.episodes ?? {};
/** Outputs written to Drive but not yet evicted (still uploading) — retried every episode and next run. */
let pendingEvict: string[] = saved.pendingEvict ?? [];
const saveState = () => writeFileSync(STATE, JSON.stringify({ episodes: state, pendingEvict }, null, 2));

// ── Episode discovery ───────────────────────────────────────────────────────

interface Episode {
  code: string;            // "E60"
  dir: string;
  source: string | null;   // chosen video file name
  sourceNote: string;      // why / warnings
  script: string | null;   // .md file name
  needSk: boolean;
  needEn: boolean;
  needShorts: boolean;
  resuming?: boolean;      // an earlier run stopped partway through this episode
}

/** What an episode needs, fixed when it starts so a resumed run finishes the same job. */
interface Plan {
  source: string;
  needSk: boolean;
  needEn: boolean;
  needShorts: boolean;
  folder?: string;         // the LUSK<n> folder chosen for its shorts, once publishing began
}
const stageDir = (code: string) => path.join(WORK, code);
const planPath = (code: string) => path.join(stageDir(code), "plan.json");
const readPlan = (code: string): Plan | null =>
  existsSync(planPath(code)) ? JSON.parse(readFileSync(planPath(code), "utf-8")) : null;
const writePlan = (code: string, plan: Plan) => writeFileSync(planPath(code), JSON.stringify(plan, null, 2));

/** Copy via a temporary name, so an interrupted copy never looks like a finished file. */
function copyAtomic(src: string, dst: string) {
  copyFileSync(src, `${dst}.part`);
  renameSync(`${dst}.part`, dst);
}

/** Cuts, intros and other partial files that are never the episode's master. */
const NOT_MASTER = /review|rewiev|intro|animation|_begin|_end|_\d{2}\.|_1\.mp4$/i;

/**
 * Pick the episode's master. In order: a forced override; `E##_NO_OVERLAY` (clean,
 * horizontal); exactly `E##.mp4`; any other full-length non-vertical video; a `_VERT`
 * version; a review cut as the last resort (flagged).
 */
function chooseSource(code: string, dir: string, videos: string[]): { file: string | null; note: string } {
  if (OVERRIDES[code]) return { file: OVERRIDES[code], note: "override" };
  const stem = (f: string) => f.replace(/\.[^.]+$/, "");
  const byStem = (s: string) => videos.find((f) => stem(f).toUpperCase() === s.toUpperCase());
  const noOverlay = byStem(`${code}_NO_OVERLAY`);
  if (noOverlay) return { file: noOverlay, note: "clean master (no overlays)" };
  const exact = byStem(code);
  if (exact) return { file: exact, note: "master" };
  const masters = videos.filter((f) => !NOT_MASTER.test(f));
  const horizontal = masters.filter((f) => !/VERT/i.test(f));
  if (horizontal.length === 1) {
    const named = horizontal[0].toUpperCase().includes(code) ? "" : " — CHECK: name doesn't contain the episode code";
    return { file: horizontal[0], note: `only full-length video${named}` };
  }
  if (horizontal.length > 1) {
    // Prefer the largest file: a full episode, not an excerpt
    const largest = horizontal.sort((a, b) => statSync(path.join(dir, b)).size - statSync(path.join(dir, a)).size)[0];
    return { file: largest, note: `largest of ${horizontal.length} candidates — CHECK` };
  }
  const vert = masters.find((f) => /VERT/i.test(f));
  if (vert) return { file: vert, note: "vertical version only" };
  const review = videos.find((f) => /review|rewiev/i.test(f));
  if (review) return { file: review, note: "only a review cut — CHECK it is the final edit" };
  return { file: null, note: "no video" };
}

function discover(): Episode[] {
  const out: Episode[] = [];
  for (const name of readdirSync(EPISODES).sort()) {
    const m = /^(E\d{2,3})\b/i.exec(name);
    const dir = path.join(EPISODES, name);
    if (!m || !statSync(dir).isDirectory()) continue;
    const code = m[1].toUpperCase();
    if (ONLY && !ONLY.includes(code)) continue;
    if (FROM && code.localeCompare(FROM, undefined, { numeric: true }) < 0) continue;

    const files = readdirSync(dir);
    const videos = files.filter((f) => /\.(mp4|mov|mkv)$/i.test(f) && !f.startsWith("."));
    const mds = files.filter((f) => /\.md$/i.test(f));
    const script = mds.find((f) => f.toUpperCase().startsWith(code)) ?? mds[0] ?? null;
    const shortsDir = path.join(dir, "SHORTS");
    const hasShorts = existsSync(shortsDir) && readdirSync(shortsDir).some((s) => {
      const p = path.join(shortsDir, s);
      return /^LUSK/i.test(s) && statSync(p).isDirectory() && readdirSync(p).some((f) => f.toLowerCase().endsWith(".mp4"));
    });
    const { file, note } = chooseSource(code, dir, videos);
    const needSk = !existsSync(path.join(dir, `${code}_captions_sk.srt`));
    const needEn = !existsSync(path.join(dir, `${code}_captions_en.srt`));
    const plan = readPlan(code);
    if (plan) {
      // Started earlier: finish that job — its own partial outputs would otherwise hide it
      const { source, needSk, needEn, needShorts } = plan;
      out.push({ code, dir, source, sourceNote: "resuming", script, needSk, needEn, needShorts, resuming: true });
      continue;
    }
    out.push({
      code, dir, source: file, sourceNote: note, script, needSk, needEn,
      // An episode missing subtitles gets fresh shorts too, even beside an older LUSK folder
      needShorts: !hasShorts || needSk || needEn,
    });
  }
  return out;
}

// ── Disk ────────────────────────────────────────────────────────────────────

const freeGb = () => { const s = statfsSync(WORK); return (s.bavail * s.bsize) / 1e9; };

const EVICT_BIN = path.join(WORK, "evict");
function ensureEvictTool() {
  if (!EVICT || existsSync(EVICT_BIN)) return;
  execFileSync("swiftc", ["-O", path.join(__dirname, "evict.swift"), "-o", EVICT_BIN], { stdio: "inherit" });
}
/** Evict local copies; returns the paths that could not be evicted yet (e.g. still uploading). */
function evict(paths: string[]): string[] {
  if (!EVICT || paths.length === 0) return [];
  let out = "";
  try {
    out = execFileSync(EVICT_BIN, paths, { encoding: "utf-8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  return out.split("\n").filter((l) => l.startsWith("failed\t")).map((l) => l.split("\t")[1]);
}

// ── One episode ─────────────────────────────────────────────────────────────

const safeName = (title: string) => title.replace(/[/:?"\\*<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "short";

function nextLuskFolder(dir: string): string {
  for (let n = 1; ; n++) {
    const p = path.join(dir, "SHORTS", `LUSK${n}`);
    if (!existsSync(p)) return p;
  }
}

async function waitReady(lusk: Lusk, id: string, ep: Episode) {
  let last = "";
  for (;;) {
    const s = await lusk.api<any>(`/api/projects/${id}`);
    const key = `${s.state} ${String(s.message).replace(/\d+%|\(.*?\)|\.\.\.$/g, "").trim()}`;
    if (key !== last) { log(`  ${ep.code} ${s.state} ${s.progress}% ${s.message}`); last = key; }
    if (s.state === "READY") return s;
    if (s.state === "IDLE") throw new Error(`project has no video (${s.message})`);
    if (s.progress === -1) throw new Error(s.message);
    if (s.state === "ALIGNING" && s.progress === 100 && /fail|manual|cancel/i.test(s.message)) throw new Error(s.message);
    await sleep(2000);
  }
}

async function runEpisode(ep: Episode) {
  const stage = stageDir(ep.code);
  mkdirSync(stage, { recursive: true });
  const plan: Plan = readPlan(ep.code) ?? { source: ep.source!, needSk: ep.needSk, needEn: ep.needEn, needShorts: ep.needShorts };
  writePlan(ep.code, plan);
  const profile = path.join(WORK, "profile");
  const sourcePath = path.join(ep.dir, ep.source!);

  const need = statSync(sourcePath).size / 1e9 + MIN_FREE_GB;
  if (freeGb() < need) {
    pendingEvict = evict(pendingEvict);
    if (freeGb() < need) throw new Error(`only ${freeGb().toFixed(1)} GB free, need ${need.toFixed(1)} GB — free some space and re-run`);
  }

  const lusk = await launchLusk({ userDataDir: profile });
  current = lusk;
  let projectId: string | null = null;
  let finished = false;
  try {
    const projectDir = path.join(ep.dir, "PROJECT", "LUSK");
    mkdirSync(projectDir, { recursive: true });
    const projectPath = path.join(projectDir, `${ep.code}_auto.lusk`);
    if (existsSync(projectPath)) {
      ({ projectId } = await lusk.api<any>("/api/projects/open", { method: "POST", headers: json, body: JSON.stringify({ projectPath }) }));
      log(`  ${ep.code} reopened ${path.basename(projectPath)}`);
    } else {
      ({ projectId } = await lusk.api<any>("/api/projects/create", { method: "POST", headers: json, body: JSON.stringify({ projectPath }) }));
    }
    let s = await lusk.api<any>(`/api/projects/${projectId}`);
    // A new project — or one an interruption left before its video/script were set
    if (s.state === "IDLE") {
      await lusk.api(`/api/projects/${projectId}/select-video`, { method: "POST", headers: json, body: JSON.stringify({ videoPath: sourcePath }) });
    }
    if (ep.script && !s.scriptText && (s.state === "IDLE" || s.state === "UPLOADING")) {
      await lusk.api(`/api/projects/${projectId}/script`, {
        method: "POST", headers: json,
        body: JSON.stringify({ scriptText: readFileSync(path.join(ep.dir, ep.script), "utf-8") }),
      });
    }
    s = await lusk.api<any>(`/api/projects/${projectId}`);
    if (s.state === "UPLOADING") {
      await lusk.api("/api/transcribe", { method: "POST", headers: json, body: JSON.stringify({ sessionId: projectId }) });
    } else if (s.state === "ALIGNING") {
      await lusk.api(`/api/projects/${projectId}/run-gemini`, { method: "POST" });
    }
    s = await waitReady(lusk, projectId!, ep);

    // Subtitles (full episode) — the English translation only exists right after a run
    for (const lang of ["sk", "en"] as const) {
      if (lang === "sk" ? !plan.needSk : !plan.needEn) continue;
      const res = await fetch(`${lusk.baseUrl}/api/projects/${projectId}/captions${lang === "en" ? "-en" : ""}.srt`);
      if (res.ok) writeFileSync(path.join(stage, `${ep.code}_captions_${lang}.srt`), await res.text());
      else log(`  ${ep.code} ${lang} subtitles unavailable (${res.status})`);
    }

    // Shorts
    const clips: any[] = s.viralClips ?? [];
    if (plan.needShorts) {
      const done = clips.filter((c, i) => existsSync(path.join(stage, `${String(i).padStart(2, "0")} ${safeName(c.title)}.mp4`))).length;
      log(`  ${ep.code} rendering ${clips.length} shorts${done ? ` (${done} already done)` : ""}`);
      for (const [i, clip] of clips.entries()) {
        const staged = path.join(stage, `${String(i).padStart(2, "0")} ${safeName(clip.title)}.mp4`);
        if (existsSync(staged)) continue;
        // the server's render key: getClipRange (shared/types.ts) — trims, default 900 ms tail
        const key = `${clip.startMs + (clip.trimStartDelta ?? 0)}-${clip.endMs + (clip.trimEndDelta ?? 900)}`;
        await lusk.api("/api/render", { method: "POST", headers: json, body: JSON.stringify({ sessionId: projectId, clip, offsetX: clip.speakerOffsetX ?? 0 }) });
        for (;;) {
          const st = await lusk.api<any>(`/api/projects/${projectId}`);
          const r = st.renders?.[key];
          if (r?.status === "exported") break;
          if (r?.status === "error") throw new Error(`render "${clip.title}": ${r.message}`);
          await sleep(2000);
        }
        copyAtomic(path.join(profile, "lusk_temp", projectId!, `output_${key}.mp4`), staged);
        log(`  ${ep.code} short ${i + 1}/${clips.length} (${clip.viralityScore ?? "-"}) ${clip.title}`);
      }
    }
    finished = true;
  } finally {
    await lusk.close();
    current = null;
    // Session temp (renders, framing and Gemini caches): dropped once everything is staged,
    // kept after an interruption or failure so the next run resumes from it
    if (projectId && finished) rmSync(path.join(profile, "lusk_temp", projectId), { recursive: true, force: true });
  }

  // Publish: shorts into a new LUSK<n> folder, subtitles at the root — never overwriting.
  // The folder is recorded first, so an interrupted publish continues into the same one.
  const written: string[] = [];
  const stagedShorts = readdirSync(stage).filter((f) => f.endsWith(".mp4")).sort();
  if (plan.needShorts && stagedShorts.length) {
    plan.folder ??= nextLuskFolder(ep.dir);
    writePlan(ep.code, plan);
    mkdirSync(plan.folder, { recursive: true });
    const used = new Set<string>();
    for (const f of stagedShorts) {
      let name = f.replace(/^\d{2} /, "");
      for (let n = 2; used.has(name); n++) name = name.replace(/( \(\d+\))?\.mp4$/, ` (${n}).mp4`);
      used.add(name);
      const dst = path.join(plan.folder, name);
      if (!existsSync(dst)) copyAtomic(path.join(stage, f), dst); // present = copied by the interrupted run
      written.push(dst);
    }
    log(`  ${ep.code} ${stagedShorts.length} shorts → ${path.relative(ep.dir, plan.folder)}/`);
  }
  for (const f of readdirSync(stage).filter((f) => f.endsWith(".srt"))) {
    const dst = path.join(ep.dir, f);
    if (!existsSync(dst)) { copyAtomic(path.join(stage, f), dst); written.push(dst); log(`  ${ep.code} ${f}`); }
  }
  rmSync(stage, { recursive: true, force: true });

  // Free the SSD: the source now, the uploads once Drive has them
  if (EVICT) {
    const left = evict([sourcePath]);
    if (left.length) log(`  ${ep.code} could not evict the source yet: ${left.join(", ")}`);
    pendingEvict = evict([...pendingEvict, ...left]).concat(written);
  }
  return { shorts: stagedShorts.length };
}

// ── Main ────────────────────────────────────────────────────────────────────

/** The running app, if any — Ctrl+C lets Playwright close it gracefully (server jobs stop too). */
let current: Lusk | null = null;
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) return; // a second Ctrl+C: Playwright force-kills the app
  interrupted = true;
  log("interrupted — closing Lusk; run the same command again to resume");
  saveState();
  if (!current) process.exit(130);
});

async function main() {
  const episodes = discover();
  const todo = episodes.filter((e) => e.needSk || e.needEn || e.needShorts);
  console.log(`${episodes.length} episodes, ${todo.length} with something missing:\n`);
  for (const e of todo) {
    const what = [e.needShorts && "shorts", e.needSk && "sk.srt", e.needEn && "en.srt"].filter(Boolean).join(" + ");
    console.log(`  ${e.code}  ${what.padEnd(26)} ${e.source ?? "—"}  (${e.sourceNote})${e.script ? `  script: ${e.script}` : ""}`);
  }
  console.log(`\nfree: ${freeGb().toFixed(1)} GB · work dir: ${WORK}\n`);
  if (DRY) return;

  const dist = path.join(REPO, "electron/dist/main.js");
  if (!existsSync(dist)) throw new Error("electron/dist/main.js missing — run `npm run build:electron` first");
  ensureEvictTool();

  for (const ep of todo) {
    if (interrupted) break;
    if (!ep.source) { log(`${ep.code} skipped: no video`); state[ep.code] = { status: "skipped", at: new Date().toISOString(), detail: "no video" }; saveState(); continue; }
    log(`${ep.code} ${ep.resuming ? "resume" : "start"} — ${ep.source}${ep.script ? ` + ${ep.script}` : ""}`);
    const t0 = Date.now();
    try {
      const { shorts } = await runEpisode(ep);
      state[ep.code] = { status: "done", at: new Date().toISOString(), detail: `${shorts} shorts, ${((Date.now() - t0) / 60000).toFixed(0)} min` };
      log(`${ep.code} done in ${((Date.now() - t0) / 60000).toFixed(0)} min`);
    } catch (err) {
      if (interrupted) return; // the app was closed under it; Playwright exits once it's down
      const msg = err instanceof Error ? err.message : String(err);
      state[ep.code] = { status: "failed", at: new Date().toISOString(), detail: msg };
      log(`${ep.code} FAILED: ${msg}`);
      if (/GB free/.test(msg)) { saveState(); break; } // out of disk: stop, don't fail every episode after it
    }
    saveState();
  }
  if (pendingEvict.length) {
    pendingEvict = evict(pendingEvict);
    if (pendingEvict.length) log(`${pendingEvict.length} uploaded outputs still local (Drive is uploading) — the next run evicts them`);
  }
  saveState();
  const failed = Object.entries(state).filter(([, s]) => s.status === "failed");
  log(`finished: ${Object.values(state).filter((s) => s.status === "done").length} done, ${failed.length} failed${failed.length ? ` (${failed.map(([c]) => c).join(", ")})` : ""}`);
}

main().catch((e) => { log(`FATAL ${e instanceof Error ? e.stack : e}`); process.exit(1); });
