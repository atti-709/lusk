/**
 * Ad hoc end-to-end check of the headless engine: transcribe → render with no window.
 *
 *   cd electron && npx tsx e2e/headless-run.ts <video> [dev|packaged]
 *
 * Prints the window/Dock state and the stages it passed; exits non-zero on failure.
 */
import { launchLusk } from "./harness";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const json = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const video = process.argv[2];
  if (!video) throw new Error("usage: tsx e2e/headless-run.ts <video> [dev|packaged]");
  const target = process.argv[3] === "packaged" ? "packaged" : "dev";
  const lusk = await launchLusk({ headless: true, target });
  try {
    const state = await lusk.app.evaluate(({ BrowserWindow, app }) => ({
      windows: BrowserWindow.getAllWindows().length,
      dockVisible: app.dock?.isVisible() ?? false,
    }));
    console.log(`target=${target} port=${lusk.port} window=${lusk.window} windows=${state.windows} dockVisible=${state.dockVisible}`);

    const projectPath = path.join(mkdtempSync(path.join(tmpdir(), "lusk-headless-")), "t.lusk");
    const { projectId } = await lusk.api<any>("/api/projects/create", { method: "POST", headers: json, body: JSON.stringify({ projectPath }) });
    await lusk.api(`/api/projects/${projectId}/select-video`, { method: "POST", headers: json, body: JSON.stringify({ videoPath: video }) });
    await lusk.api("/api/transcribe", { method: "POST", headers: json, body: JSON.stringify({ sessionId: projectId }) });

    let s: any;
    for (let last = ""; ; await sleep(2000)) {
      s = await lusk.api<any>(`/api/projects/${projectId}`);
      const key = `${s.state} ${s.message}`;
      if (key !== last) { console.log(`  ${s.state} ${s.progress}% ${s.message}`); last = key; }
      if (s.state === "READY") break;
      if (s.progress === -1) throw new Error(s.message);
      if (s.state === "ALIGNING" && s.progress === 100 && /fail|manual|cancel/i.test(s.message)) break;
    }
    const words = s.transcript?.words ?? [];
    console.log(`transcribed: state=${s.state} words=${words.length}: ${words.slice(0, 12).map((w: any) => w.text).join(" ")}`);
    if (words.length === 0) throw new Error("no words transcribed");

    const clip = { title: "headless", startMs: 0, endMs: 12000, hookText: "headless" };
    await lusk.api("/api/render", { method: "POST", headers: json, body: JSON.stringify({ sessionId: projectId, clip, offsetX: 0 }) });
    const key = `${clip.startMs}-${clip.endMs}`;
    for (let last = ""; ; await sleep(2000)) {
      const st = await lusk.api<any>(`/api/projects/${projectId}`);
      const r = st.renders?.[key];
      const now = `${r?.status} ${r?.progress} ${r?.message}`;
      if (now !== last) { console.log(`  render ${now}`); last = now; }
      if (r?.status === "exported") break;
      if (r?.status === "error") throw new Error(`render: ${r.message}`);
    }
    const after = await lusk.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    console.log(`DONE transcribe + render, windows still ${after}, output ${path.join(lusk.userDataDir, "lusk_temp", projectId, `output_${key}.mp4`)}`);
  } finally {
    await lusk.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
