// Replay the proofread edits a run logged as rejected through the current matcher.
//   npx tsx tools/quality/proofread-replay.ts [<version> [--dir <runs dir>] [-v]]    (default version 01-v0)
// Per item the numbered lines are rebuilt from transcript_raw.json with the proofread's own splitter, so the line
// numbers in the log line up for items without a script (the proofread saw the heard words). For items with a
// script it saw the corrected text, which a run does not store: those are counted apart and not replayed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProofreadEdits, buildProofreadLines, type ProofreadEdit } from '../../server/src/services/proofread';

const version = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '01-v0';
const dirArg = process.argv.indexOf('--dir');
const runs = dirArg >= 0 ? process.argv[dirArg + 1] : path.join(os.homedir(), 'LuskCorpus', 'runs');
const verbose = process.argv.includes('-v');
const MARK = "edit(s) that didn't match the transcript: ";

let total = 0, replayed = 0, applied = 0, withScript = 0;
for (const id of fs.readdirSync(path.join(runs, version)).sort()) {
  const dir = path.join(runs, version, id);
  const logPath = path.join(dir, 'log.txt');
  if (!fs.existsSync(logPath)) continue;
  const rejected: ProofreadEdit[] = [];
  for (const line of fs.readFileSync(logPath, 'utf-8').split('\n')) {
    const at = line.indexOf(MARK);
    if (at >= 0) rejected.push(...JSON.parse(line.slice(at + MARK.length)));
  }
  if (!rejected.length) continue;
  total += rejected.length;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
  if (meta.script) { withScript += rejected.length; continue; }
  const words = JSON.parse(fs.readFileSync(path.join(dir, 'transcript_raw.json'), 'utf-8')).words;
  const lines = buildProofreadLines(words);
  // one edit at a time: they were rejected independently, overlaps among them are not the matcher's doing
  let ok = 0;
  for (const e of rejected) {
    const r = applyProofreadEdits(words, lines, [e]);
    if (r.applied.length) {
      ok++;
      if (verbose) console.log(`  ${id} line ${e.line}: "${r.applied[0].from}" → "${r.applied[0].to}"`);
    } else if (verbose) console.log(`  ${id} line ${e.line}: STILL REJECTED find="${e.find}" replace="${e.replace}"`);
  }
  replayed += rejected.length;
  applied += ok;
  console.log(`${id}: ${ok}/${rejected.length} now apply`);
}
console.log(`\n${version}: ${total} rejected edits logged, ${withScript} from items with a script (not replayable), ${replayed} replayed: ${applied} now apply (${replayed ? ((100 * applied) / replayed).toFixed(1) : 0} %)`);
