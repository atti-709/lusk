import type { TranscriptWord } from "@lusk/shared";

/**
 * Sparse-edit proofreading: the transcript goes to Gemini as numbered sentences and
 * comes back as a short list of {line, find → replace} spans. Nothing positional has to
 * survive the round trip — no row counts, no timestamps — so the model's whole attention
 * is on the language. Every span is checked against the transcript verbatim before it is
 * applied, and the words it introduces are timed from the ones it replaces, so a fix can
 * never shift the timing of anything around it.
 */

/** One numbered line of the proofread prompt: a sentence, as indices into the word list. */
export interface ProofreadLine {
  id: number;
  words: number[];
}

/** One fix as Gemini reports it. */
export interface ProofreadEdit {
  line: number;
  /** Exact contiguous words from that line, as written. */
  find: string;
  /** What they should be — any number of words, empty to delete. */
  replace: string;
  reason?: string;
}

export interface AppliedEdit {
  from: string;
  to: string;
  atMs: number;
  reason?: string;
}

export interface ProofreadResult {
  words: TranscriptWord[];
  applied: AppliedEdit[];
  /** Edits dropped because their `find` didn't match the line, or they looked like a rewrite. */
  rejected: ProofreadEdit[];
}

/** Lines longer than this are broken even without punctuation (a run-on or a missing period). */
const MAX_LINE_WORDS = 30;
/** A `find` span is a local fix, never a sentence-sized rewrite. */
const MAX_FIND_WORDS = 8;
/** Longer spans must stay close to the original text — a mishearing, not a paraphrase. */
const MAX_REWRITE_RATIO = 0.5;

const SENTENCE_END = /[.!?…]["'“”„»)\]]*$/;

/** Split the transcript into sentences, the unit a proofreader reads in. */
export function buildProofreadLines(words: TranscriptWord[]): ProofreadLine[] {
  const lines: ProofreadLine[] = [];
  let current: number[] = [];
  for (let i = 0; i < words.length; i++) {
    current.push(i);
    if (SENTENCE_END.test(words[i].word) || current.length >= MAX_LINE_WORDS) {
      lines.push({ id: lines.length + 1, words: current });
      current = [];
    }
  }
  if (current.length) lines.push({ id: lines.length + 1, words: current });
  return lines;
}

function tokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** True when an edit reads as a rewrite rather than a correction. */
function isRewrite(find: string[], replace: string[]): boolean {
  if (replace.length > find.length + 3) return true;
  if (find.length < 3) return false; // a single mishearing may change the whole word
  const a = normalize(find.join(" "));
  const b = normalize(replace.join(" "));
  return editDistance(a, b) > MAX_REWRITE_RATIO * Math.max(a.length, b.length);
}

/** A token with the commas and full stops attached to it removed — what a `find` may omit. */
function looseKey(token: string): string {
  return token.normalize("NFC").replace(/[,.]/g, "");
}

/** The punctuation a token ends in ("zhromáždění," → ","), quotes and brackets included. */
function trailingPunct(token: string): string {
  return token.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";
}

/**
 * Position of `needle` as a contiguous run inside `haystack`, skipping taken positions.
 * A run that matches verbatim wins; failing that, one that matches once the commas and
 * full stops attached to words are ignored (Gemini often quotes "zhromáždění," as
 * "zhromáždění").
 */
function findRun(haystack: string[], needle: string[], taken: Set<number>, offset: number): number {
  const exact = (a: string, b: string) => a.normalize("NFC") === b.normalize("NFC");
  const loose = (a: string, b: string) => looseKey(a) === looseKey(b);
  const matches = (eq: (a: string, b: string) => boolean): number[] => {
    const at: number[] = [];
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      let ok = true;
      for (let k = 0; k < needle.length && ok; k++) {
        ok = !taken.has(offset + i + k) && eq(haystack[i + k], needle[k]);
      }
      if (ok) at.push(i);
    }
    return at;
  };
  const verbatim = matches(exact);
  if (verbatim.length) return verbatim[0];
  // which of several loose matches Gemini meant is unknown: only an unambiguous one is taken
  const fuzzy = matches(loose);
  if (fuzzy.length === 1) return fuzzy[0];
  return -1;
}

/**
 * The words an edit puts in, with the line's own punctuation kept wherever the edit did not
 * speak of it: tokens `find` and `replace` share at either end stay as written on the line,
 * and a changed last word that carries no punctuation of its own gets the one the replaced
 * word ended in — unless `find` quoted that punctuation, which makes dropping it deliberate.
 */
function keepLinePunctuation(old: string[], find: string[], replace: string[]): string[] {
  const out = [...replace];
  const same = (a: string, b: string) => a.normalize("NFC") === b.normalize("NFC");
  let p = 0;
  while (p < find.length && p < replace.length && same(find[p], replace[p])) p++;
  let q = 0;
  while (q < find.length - p && q < replace.length - p && same(find[find.length - 1 - q], replace[replace.length - 1 - q])) q++;
  for (let i = 0; i < p; i++) out[i] = old[i];
  for (let i = 0; i < q; i++) out[out.length - 1 - i] = old[old.length - 1 - i];
  const lost = (i: number) => trailingPunct(find[i]) !== trailingPunct(old[i]); // `find` left old[i]'s punctuation out
  const middleEnd = replace.length - q;
  if (middleEnd === p && p > 0 && p < find.length) {
    // words deleted after a kept word: the kept word's own punctuation went with the deleted ones
    const d = find.length - q - 1; // the last deleted word: its punctuation, if `find` left it out, stays
    out[p - 1] = replace[p - 1] + (lost(d) && trailingPunct(replace[p - 1]) === "" ? trailingPunct(old[d]) : "");
  } else if (find.length === replace.length) {
    // one word for one word: each changed word keeps the punctuation `find` left out
    for (let i = p; i < replace.length - q; i++) {
      if (lost(i) && trailingPunct(replace[i]) === "") out[i] = replace[i] + trailingPunct(old[i]);
    }
  } else if (q === 0 && lost(find.length - 1)) {
    // the replaced span's last word carried punctuation `find` left out: it moves to the new last word
    const orig = trailingPunct(old[old.length - 1]);
    const last = out.length - 1;
    if (p === find.length && last >= p) out[p - 1] = old[p - 1].slice(0, old[p - 1].length - orig.length);
    if (last >= p && trailingPunct(replace[last]) === "") {
      out[last] = (p === replace.length ? out[last].slice(0, out[last].length - trailingPunct(out[last]).length) : replace[last]) + orig;
    }
  }
  return out;
}

/** Split [fromMs, toMs) between `texts` in proportion to their length. */
function spread(texts: string[], fromMs: number, toMs: number): TranscriptWord[] {
  const weights = texts.map((t) => Math.max(1, t.length));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: TranscriptWord[] = [];
  let at = fromMs;
  for (let i = 0; i < texts.length; i++) {
    const end = i === texts.length - 1 ? toMs : at + ((toMs - fromMs) * weights[i]) / total;
    out.push({ word: texts[i], startMs: Math.round(at), endMs: Math.round(end) });
    at = end;
  }
  return out;
}

/**
 * Re-time a replaced span. Words the edit leaves unchanged at either end keep their own
 * timings; only the changed middle is re-timed, inside the time the replaced words took.
 * A pure insertion ("modliť slová" → "modliť sa slová") borrows the tail of the word
 * before it, the way an inserted row is timed when a corrected TSV is parsed.
 */
function retime(old: TranscriptWord[], replacement: string[]): TranscriptWord[] {
  let p = 0;
  while (p < old.length && p < replacement.length && normalize(old[p].word) === normalize(replacement[p])) p++;
  let q = 0;
  while (
    q < old.length - p && q < replacement.length - p &&
    normalize(old[old.length - 1 - q].word) === normalize(replacement[replacement.length - 1 - q])
  ) q++;

  const keep = (w: TranscriptWord, text: string): TranscriptWord => ({ ...w, word: text });
  const prefix = old.slice(0, p).map((w, i) => keep(w, replacement[i]));
  const suffix = old.slice(old.length - q).map((w, i) => keep(w, replacement[replacement.length - q + i]));
  const oldMid = old.slice(p, old.length - q);
  const newMid = replacement.slice(p, replacement.length - q);

  if (newMid.length === 0) return [...prefix, ...suffix];
  if (oldMid.length > 0) {
    return [...prefix, ...spread(newMid, oldMid[0].startMs, oldMid[oldMid.length - 1].endMs), ...suffix];
  }
  // Pure insertion: share the neighbour's slot with the new words
  if (prefix.length > 0) {
    const host = prefix[prefix.length - 1];
    const parts = spread([host.word, ...newMid], host.startMs, host.endMs);
    return [...prefix.slice(0, -1), ...parts, ...suffix];
  }
  const host = suffix[0];
  const parts = spread([...newMid, host.word], host.startMs, host.endMs);
  return [...parts, ...suffix.slice(1)];
}

/** Apply Gemini's edits to the transcript, dropping any that don't verifiably fit. */
export function applyProofreadEdits(
  words: TranscriptWord[],
  lines: ProofreadLine[],
  edits: ProofreadEdit[],
): ProofreadResult {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const taken = new Set<number>();
  const accepted: { start: number; end: number; replacement: string[]; edit: ProofreadEdit }[] = [];
  const rejected: ProofreadEdit[] = [];

  for (const edit of edits) {
    const line = byId.get(Number(edit.line));
    const find = tokens(edit.find ?? "");
    const replace = tokens(edit.replace ?? "");
    if (!line || find.length === 0 || find.length > MAX_FIND_WORDS || find.join(" ") === replace.join(" ") || isRewrite(find, replace)) {
      rejected.push(edit);
      continue;
    }
    const lineTokens = line.words.map((i) => words[i].word);
    const at = findRun(lineTokens, find, taken, line.words[0]);
    if (at < 0) {
      rejected.push(edit);
      continue;
    }
    const oldLast = lineTokens[at + find.length - 1];
    // a deletion would take the line's sentence end or comma with it; `find` didn't quote it
    if (replace.length === 0 && trailingPunct(oldLast) !== trailingPunct(find[find.length - 1])) {
      rejected.push(edit);
      continue;
    }
    const start = line.words[at];
    const oldTexts = lineTokens.slice(at, at + find.length);
    const final = keepLinePunctuation(oldTexts, find, replace);
    if (final.join(" ") === oldTexts.join(" ")) {
      rejected.push(edit); // nothing left to change once the line's punctuation is kept
      continue;
    }
    for (let k = 0; k < find.length; k++) taken.add(start + k);
    accepted.push({ start, end: start + find.length, replacement: final, edit });
  }

  accepted.sort((a, b) => a.start - b.start);
  const out: TranscriptWord[] = [];
  const applied: AppliedEdit[] = [];
  let cursor = 0;
  for (const { start, end, replacement, edit } of accepted) {
    out.push(...words.slice(cursor, start));
    const old = words.slice(start, end);
    const oldTexts = old.map((w) => w.word);
    const final = replacement;
    out.push(...retime(old, final));
    applied.push({
      from: oldTexts.join(" "),
      to: final.join(" "),
      atMs: old[0].startMs,
      reason: edit.reason,
    });
    cursor = end;
  }
  out.push(...words.slice(cursor));

  for (const w of out) w.endMs = Math.max(w.endMs, w.startMs + 1);
  return { words: out, applied, rejected };
}
