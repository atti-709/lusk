/**
 * What the reference script knows that the text passes miss.
 *
 * The script is the author's own text. Two things from it reach the captions wrong when the
 * passes are left to the model alone:
 *
 * - a form that differs from the heard one only by its diacritics ("evanjelia" for "evanjeliá",
 *   E71: 10 of 18 left after both passes). Both are real Slovak words ("evanjelia" is the genitive
 *   singular), so neither a dictionary nor a similarity test can pick one; the words around it can.
 *   `restoreScriptDiacritics` takes the script's form when the script, wherever it carries the
 *   same neighbouring words, always writes it that way.
 * - names (a "Craig Groeschel" heard as "Crap Groeschel"). `scriptGlossary` lists the script's
 *   proper nouns so the proofread pass looks for garbled versions of exactly these.
 */

interface Word { word: string }

const PUNCT = /^[„"“«(\[]+|[.,!?:;…"“”»)\]]+$/g;
const core = (w: string) => w.replace(PUNCT, "");
const plain = (w: string) => w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const LETTERS = /^\p{L}+$/u;
const TOKEN = /\p{L}+/gu;

/** The script's words as written (lower case), without markdown and punctuation. */
function scriptTokens(script: string): string[] {
  return (script.normalize("NFC").match(TOKEN) ?? []).map((t) => t.toLowerCase());
}

/** Whether `script` is `heard` with diacritics added: same letters, never a diacritic dropped or swapped. */
function addsDiacritics(heard: string, script: string): boolean {
  if (heard === script || heard.length !== script.length) return false;
  for (let i = 0; i < heard.length; i++) {
    if (heard[i] === script[i]) continue;
    if (plain(heard[i]) !== heard[i] || plain(script[i]) !== plain(heard[i])) return false;
  }
  return true;
}

type Variants = Map<string, Map<string, number>>;

/** plain neighbour keys → the exact forms the script writes the middle word in. */
function contextVariants(tokens: string[]): { tri: Variants; left: Variants; right: Variants } {
  const tri: Variants = new Map();
  const left: Variants = new Map();
  const right: Variants = new Map();
  const add = (m: Variants, key: string, form: string) => {
    const forms = m.get(key) ?? new Map<string, number>();
    forms.set(form, (forms.get(form) ?? 0) + 1);
    m.set(key, forms);
  };
  const p = tokens.map(plain);
  for (let j = 0; j < tokens.length; j++) {
    if (j > 0) add(left, `${p[j - 1]} ${p[j]}`, tokens[j]);
    if (j + 1 < tokens.length) add(right, `${p[j]} ${p[j + 1]}`, tokens[j]);
    if (j > 0 && j + 1 < tokens.length) add(tri, `${p[j - 1]} ${p[j]} ${p[j + 1]}`, tokens[j]);
  }
  return { tri, left, right };
}

/**
 * The words with the script's diacritics put back. A word is changed only when the script, around
 * the same neighbouring words (both, or either one when the other is not in the script), always
 * writes the word with more diacritics than the heard form and never as the heard form itself.
 * A script written without diacritics never removes one, and a word the script never uses in
 * that context stays as it is.
 */
export function restoreScriptDiacritics<T extends Word>(words: T[], script: string | null): T[] {
  if (!script) return words;
  const { tri, left, right } = contextVariants(scriptTokens(script));
  const lower = words.map((w) => core(w.word).normalize("NFC").toLowerCase());
  const letters = lower.map((w) => LETTERS.test(w));
  const out = words.slice();
  let changed = 0;
  for (let i = 0; i < words.length; i++) {
    const h = lower[i];
    if (!letters[i] || h.length < 3) continue;
    const prev = i > 0 && letters[i - 1] ? plain(lower[i - 1]) : null;
    const next = i + 1 < words.length && letters[i + 1] ? plain(lower[i + 1]) : null;
    const hp = plain(h);
    const forms = new Set<string>();
    let found = false;
    const take = (m: Variants, key: string) => {
      const f = m.get(key);
      if (!f) return;
      found = true;
      f.forEach((_, form) => forms.add(form));
    };
    if (prev && next) take(tri, `${prev} ${hp} ${next}`);
    if (!found) {
      if (prev) take(left, `${prev} ${hp}`);
      if (next) take(right, `${hp} ${next}`);
    }
    if (!found || forms.size !== 1) continue;
    const [form] = forms;
    if (!addsDiacritics(h, form)) continue;
    const original = core(words[i].word);
    const cased = original[0] !== original[0].toLowerCase() ? form[0].toUpperCase() + form.slice(1) : form;
    out[i] = { ...words[i], word: words[i].word.replace(original, cased) };
    changed++;
  }
  if (changed) console.log(`[script forms] restored the script's diacritics on ${changed} word${changed === 1 ? "" : "s"}`);
  return out;
}

const CONNECTORS = new Set(["z", "de", "of", "von", "van", "da", "di", "del", "la", "le", "the", "bin", "ibn"]);
const MAX_GLOSSARY = 200;

/**
 * The script's proper nouns, for the proofread prompt: runs of capitalised words that are not just a
 * sentence's first word ("Craig Groeschel", "Irenej z Lyonu", "Solženicyn"), in script order, multi-word
 * names first. A name the transcript already carries three times or more is heard right and left out.
 */
export function scriptGlossary(script: string, heard: string[] = []): string[] {
  const text = script.normalize("NFC").replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const re = /\p{L}[\p{L}'’-]*/gu;
  const toks: { t: string; start: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) toks.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  const isCap = (t: string) => t.length >= 2 && t[0] !== t[0].toLowerCase() && t !== t.toUpperCase();
  // a token opens a sentence after a full stop, a question or exclamation mark, a line break, or at the start
  const opens = (k: number) => k === 0 || /[.!?\n]/.test(text.slice(toks[k - 1].end, toks[k].start));
  const seen = new Set<string>();
  const multi: string[] = [];
  const single: string[] = [];
  for (let k = 0; k < toks.length;) {
    if (!isCap(toks[k].t)) { k++; continue; }
    let e = k;
    while (e + 1 < toks.length) {
      if (isCap(toks[e + 1].t) && !/[.!?:;,\n]/.test(text.slice(toks[e].end, toks[e + 1].start))) e++;
      else if (CONNECTORS.has(toks[e + 1].t) && e + 2 < toks.length && isCap(toks[e + 2].t) && !/[.!?:;,\n]/.test(text.slice(toks[e].end, toks[e + 2].start))) e += 2;
      else break;
    }
    const term = toks.slice(k, e + 1).map((x) => x.t).join(" ");
    const first = opens(k);
    if (!seen.has(term) && (e > k || !first)) {
      seen.add(term);
      (e > k ? multi : single).push(term);
    }
    k = e + 1;
  }
  const joined = heard.join(" ");
  const heardTimes = (term: string) => joined.split(term).length - 1;
  return [...multi, ...single].filter((t) => heardTimes(t) < 3).slice(0, MAX_GLOSSARY);
}
