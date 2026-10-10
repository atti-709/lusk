/**
 * Map Gemini's script-corrected rows back onto the heard words.
 *
 * The correction pass is asked for one row per input row, but with the script in view it
 * inserts script words that were never said and drops others. Taken by index, one insertion
 * and a later drop in the same chunk shift every row in between onto its neighbour's time
 * (E01, E02, E09). So the rows are aligned by content instead (global alignment over the
 * row texts), and the spoken words decide what is kept:
 *
 * - a row aligned to a similar heard word takes the correction (diacritics, spelling,
 *   punctuation, capitals);
 * - a row aligned to an unrelated heard word is the script overriding what was said
 *   ("ak" → "keď", "Citát od filozofa" → "Napísal historik") — the heard word stays, and
 *   the proofread pass, which sees the script too, fixes it if it really was misheard;
 * - rows with no heard word (script insertions) are dropped; heard words Gemini dropped stay.
 */

/** Strip diacritics, lowercase, keep letters and digits. */
export function normalizeWord(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Prepositions spelled by the case they govern, not by sound: "s"/"z", "k"/"ku", … */
const SPELLING_PAIRS = new Set(["s|z", "s|so", "z|zo", "k|ku", "v|vo"]);

/**
 * Whether a corrected word is a correction of the heard one rather than a different word.
 * Short words (≤3 chars) must match exactly — Slovak has many 1-3 letter words (a, i, v,
 * na, sa, to, ak…) a small edit turns into another word — except the preposition spellings
 * above; longer ones may differ by ~40% (diacritics, endings, mishearings).
 */
export function isSimilar(normA: string, normB: string): boolean {
  if (normA === normB) return true;
  if (normA.length === 0 || normB.length === 0) return false;
  if (SPELLING_PAIRS.has([normA, normB].sort().join("|"))) return true;
  if (normA.length <= 3 || normB.length <= 3) return false;
  return editDistance(normA, normB) <= Math.ceil(Math.max(normA.length, normB.length) * 0.4);
}

/**
 * Accepted on an aligned pair: similar, or one letter swapped in a short word ("Dau" → "dav",
 * "my" → "mi", "A.G." → "H.G."). A letter added or dropped is another word ("sa" ≠ "sám").
 */
function isCorrection(normA: string, normB: string): boolean {
  return isSimilar(normA, normB) || (normA.length >= 2 && normA.length === normB.length && editDistance(normA, normB) <= 1);
}

const TRAILING_PUNCT = /[.,!?:;…"“”»)]+$/;
const SENTENCE_END = /[.!?…]["“”»)]*$/;

/** A kept heard word still takes the corrected row's trailing punctuation and capital. */
function keepHeard(heard: string, corrected: string): string {
  let word = heard;
  const punct = corrected.match(TRAILING_PUNCT)?.[0];
  if (punct && !TRAILING_PUNCT.test(word)) word += punct;
  const first = corrected.replace(/^[„"“«(]+/, "")[0];
  if (first && word && first !== first.toLowerCase() && word[0] === word[0].toLowerCase()) word = word[0].toUpperCase() + word.slice(1);
  return word;
}

const rowText = (line: string) => {
  const tab = line.indexOf("\t");
  return tab >= 0 ? line.substring(tab + 1) : line;
};

/**
 * One output line per input line, each with the input's timestamp. Gemini's timestamps
 * are ignored (it reformats them).
 */
export function alignCorrectedRows(inputLines: string[], outputLines: string[]): string[] {
  const inputs = inputLines.filter((l) => l.trim()).map((l) => {
    const [ts, ...rest] = l.split("\t");
    const word = rest.join("\t");
    return { ts: ts.trim(), word, norm: normalizeWord(word) };
  });
  const outputs = outputLines.filter((l) => l.trim()).map((l) => {
    const word = rowText(l).trim();
    return { word, norm: normalizeWord(word) };
  });
  const n = inputs.length;
  const m = outputs.length;

  // Global alignment: identical +2, a correction +1, an unrelated word −1, a gap −1
  const GAP = -1;
  const score = (a: string, b: string) => (a === b ? 2 : isCorrection(a, b) ? 1 : -1);
  const S = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0 pair, 1 input only, 2 output only
  for (let i = 1; i <= n; i++) { S[i][0] = i * GAP; move[i][0] = 1; }
  for (let j = 1; j <= m; j++) { S[0][j] = j * GAP; move[0][j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const pair = S[i - 1][j - 1] + score(inputs[i - 1].norm, outputs[j - 1].norm);
      const up = S[i - 1][j] + GAP;
      const left = S[i][j - 1] + GAP;
      if (pair >= up && pair >= left) { S[i][j] = pair; move[i][j] = 0; }
      else if (up >= left) { S[i][j] = up; move[i][j] = 1; }
      else { S[i][j] = left; move[i][j] = 2; }
    }
  }

  // The path in reading order: [input row, output row], either side −1 when unmatched
  const path: [number, number][] = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const mv = i > 0 && j > 0 ? move[i][j] : i > 0 ? 1 : 2;
    path.push([mv === 2 ? -1 : --i, mv === 1 ? -1 : --j]);
  }
  path.reverse();

  // A row Gemini split in two ("Beznádej" → "Bez" + "nádeje", "planetizem" → "planéty" + "Zem")
  // leaves one half unmatched: it joins its neighbour's row when the two together read closer
  // to the heard word.
  const text = path.map(([, j]) => (j >= 0 ? outputs[j].word : ""));
  const dropped = path.map(([i]) => i < 0);
  path.forEach(([i], k) => {
    if (i >= 0) return;
    for (const nb of [k - 1, k + 1]) {
      const pair = path[nb];
      if (!pair || pair[0] < 0 || pair[1] < 0) continue;
      const joined = nb < k ? `${text[nb]} ${text[k]}` : `${text[k]} ${text[nb]}`;
      const heard = inputs[pair[0]].norm;
      if (editDistance(heard, normalizeWord(joined)) < editDistance(heard, normalizeWord(text[nb]))) {
        text[nb] = joined;
        dropped[k] = false;
        text[k] = "";
        break;
      }
    }
  });

  const words: string[] = inputs.map((inp) => inp.word);
  let pendingEnd: string | null = null; // sentence end of a dropped insertion, for the row before it
  for (let k = path.length - 1; k >= 0; k--) {
    const [i] = path[k];
    if (i < 0) {
      const end = text[k].match(TRAILING_PUNCT)?.[0];
      if (dropped[k] && end && SENTENCE_END.test(end) && pendingEnd === null) pendingEnd = end;
      continue;
    }
    if (text[k]) {
      words[i] = isCorrection(inputs[i].norm, normalizeWord(text[k])) ? text[k] : keepHeard(inputs[i].word, text[k]);
    }
    if (pendingEnd !== null) {
      if (!TRAILING_PUNCT.test(words[i])) words[i] += pendingEnd;
      pendingEnd = null;
    }
  }

  return inputs.map((inp, i) => `${inp.ts}\t${words[i]}`);
}

const ABBREVIATIONS = new Set(["napr", "tzv", "atď", "resp", "tj", "sv", "str", "č", "kap", "porov", "pozn", "dr", "mr", "st", "kr", "pr", "vs"]);

/**
 * Sentence ends followed by a lower-case word: a correction that moved full stops onto the
 * word before ("malo byť. že každý…", E06 7:09–11:26) shows up as a jump in this count.
 * Ordinals ("v 20. storočí") and abbreviations don't count.
 */
export function misplacedBreaks(lines: string[]): number {
  const words = lines.filter((l) => l.trim()).map((l) => rowText(l).trim());
  let count = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    const m = /^(.*?)[.!?]["'“”»]?$/.exec(words[i]);
    if (!m || /^\d+$/.test(m[1]) || ABBREVIATIONS.has(m[1].toLowerCase())) continue;
    const next = words[i + 1].replace(/^["'„“»(]+/, "");
    if (next && next[0] !== next[0].toUpperCase()) count++;
  }
  return count;
}

/** A corrected row whose word is in a script Slovak never uses keeps the heard word ("svetло"). */
export function keepHeardScript(inputLines: string[], alignedLines: string[], foreign: (text: string) => boolean): string[] {
  const inputs = inputLines.filter((l) => l.trim());
  return alignedLines.map((line, i) => (foreign(rowText(line)) && inputs[i] ? inputs[i] : line));
}
