// A second Gemini opinion on the T6 arbiter's decisions: the same spans and snippets asked again with another model tier
// (default gemini-3.5-flash-lite) and freshly shuffled sides, so it does not share the arbiter's answers by construction.
//   npx tsx tools/quality/arbiter-second-opinion.ts <runs>/<version> <out.json> [--items E64,...] [--model gemini-3.5-flash-lite]
// Reads <run>/<item>/arbiter.json and the item's audio (corpus WAV or ~/LuskBatch/audio/E<nn>.wav); the Gemini key comes from the
// app's config (LUSK_REGISTRY_DIR), like run.ts. Writes {"<item>:<span id>": {"verdict": "ft"|"base"|"same"|"neither"|"none"}}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runDir, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
if (!runDir || !outFile) throw new Error('usage: arbiter-second-opinion.ts <runs>/<version> <out.json> [--items a,b] [--model m]');
// both are read when the services load
process.env.LUSK_ARBITER_MODEL = flag('--model') ?? 'gemini-3.5-flash-lite';
process.env.LUSK_REGISTRY_DIR ??= path.join(os.homedir(), 'Library', 'Application Support', '@lusk', 'electron');
process.env.LUSK_TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lusk-2nd-'));


const audioFor = (item: string) =>
  [path.join(os.homedir(), 'LuskCorpus', item, 'audio.wav'), path.join(os.homedir(), 'LuskBatch', 'audio', `${item}.wav`)].find((p) => fs.existsSync(p));
const dir = path.resolve(runDir.replace(/^~/, os.homedir()));
const items = (flag('--items')?.split(',') ?? fs.readdirSync(dir)).filter((i) => fs.existsSync(path.join(dir, i, 'arbiter.json')));
async function main() {
  const { geminiService } = await import('../../server/src/services/GeminiService');
  const out: Record<string, { verdict: string }> = {};
  for (const item of items) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, item, 'arbiter.json'), 'utf-8'));
    const wav = audioFor(item);
    if (!wav) throw new Error(`no audio for ${item}`);
    const spans = doc.spans.filter((s: any) => !s.skipped && s.judged);
    const stats = await geminiService.arbitrateSpans(spans, { wavPath: wav, language: doc.language ?? 'sk', sessionId: `second-${item}` });
    for (const s of spans) out[`${item}:${s.id}`] = { verdict: s.verdict };
    console.log(`${item}: ${spans.length} spans, ${stats.calls} calls`);
  }
  fs.writeFileSync(path.resolve(outFile.replace(/^~/, os.homedir())), JSON.stringify(out));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
