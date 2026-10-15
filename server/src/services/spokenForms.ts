/**
 * Keep the endings the speaker said.
 *
 * With a script in view the correction pass "fixes" word forms toward the script's wording
 * ("neverím" → "neveríme", "kameň" → "kameňom", "vyvrátili" → "vyvrátia" in E08/E09). Where the
 * heard word and the corrected one are both real words of the language and differ only in the
 * ending, the heard one goes back. Judged by listening to 12 episodes (2026-10-15), the heard
 * ending was right 39 times and the correction 15; a change of the whole word was right far more
 * often (29:15), so only endings are guarded. Capitalised words are left alone (names: "Pascale"
 * → "Pascal", sentence starts), and so are words under four letters ("ale" → "alebo").
 */
import { pythonEnvService } from "./PythonEnvService.js";
import { spawnGroup } from "./ChildProcesses.js";

interface Word { word: string; startMs: number; endMs: number }

const PUNCT = /^[„"“«(\[]+|[.,!?:;…"“”»)\]]+$/g;
const core = (w: string) => w.replace(PUNCT, "");
const plain = (w: string) => w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
/** How it sounds: diacritics and i/y are spelling, not a different form. */
const sound = (w: string) => plain(w).replace(/y/g, "i");
const isCapital = (w: string) => w[0] !== w[0].toLowerCase();

/** Same word, other ending: a shared start of 3+ letters and at most 4 letters different after it. */
function sameStem(a: string, b: string): boolean {
  a = a.toLowerCase();
  b = b.toLowerCase();
  let k = 0;
  while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
  return k >= 3 && a.length - k <= 4 && b.length - k <= 4;
}

/** The pairs this guard would look at: [heard core, corrected core] for words at the same time. */
function candidates<T extends Word>(heard: Word[], words: T[]): Map<number, string> {
  const byTime = new Map(heard.map((h) => [`${h.startMs}-${h.endMs}`, core(h.word)]));
  const out = new Map<number, string>();
  words.forEach((w, i) => {
    const h = byTime.get(`${w.startMs}-${w.endMs}`);
    const c = core(w.word);
    if (!h || !c || h.toLowerCase() === c.toLowerCase()) return;
    if (isCapital(h) || isCapital(c) || h.length < 4 || /\s/.test(c)) return;
    if (sound(h) === sound(c) || !sameStem(h, c)) return;
    out.set(i, h);
  });
  return out;
}

/** The words with every guarded ending put back; `isWord` says which words are real. */
export function keepSpokenForms<T extends Word>(heard: Word[], words: T[], isWord: (w: string) => boolean): T[] {
  const pairs = candidates(heard, words);
  if (!pairs.size) return words;
  return words.map((w, i) => {
    const h = pairs.get(i);
    const c = core(w.word);
    if (!h || !isWord(h) || !isWord(c)) return w;
    return { ...w, word: w.word.replace(c, h) };
  });
}

/** Which of these words are real words of `lang` (scripts/wordcheck.py); null if it can't tell. */
async function realWords(words: string[], lang: string): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const proc = spawnGroup(pythonEnvService.getPythonPath(), [pythonEnvService.getScriptPath("wordcheck.py"), lang], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    proc.stderr!.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-1000)));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        console.warn(`[spoken forms] word check failed (code ${code}): ${err.trim().split("\n").at(-1) ?? ""}`);
        return resolve(null);
      }
      try {
        const valid = JSON.parse(out) as boolean[];
        resolve(new Set(words.filter((_, i) => valid[i])));
      } catch {
        resolve(null);
      }
    });
    proc.stdin!.end(JSON.stringify(words));
  });
}

/** `keepSpokenForms` with the language's dictionary; the words unchanged if there is none. */
export async function guardSpokenForms<T extends Word>(heard: Word[], words: T[], lang: string): Promise<T[]> {
  const pairs = candidates(heard, words);
  if (!pairs.size) return words;
  const asked = [...new Set([...pairs.values(), ...[...pairs.keys()].map((i) => core(words[i].word))])];
  const real = await realWords(asked, lang);
  if (!real) return words;
  const guarded = keepSpokenForms(heard, words, (w) => real.has(w));
  const kept = guarded.filter((w, i) => w !== words[i]).length;
  if (kept) console.log(`[spoken forms] kept ${kept} heard ending${kept === 1 ? "" : "s"} the correction had changed`);
  return guarded;
}
