/**
 * The two-model arbiter's pure logic (T6): where two decodes of the same VAD chunk differ, which spans go to
 * Gemini to be judged by listening, how the answers are applied. No I/O here — `GeminiService.arbitrateSpans`
 * does the listening, `WhisperService` wires it between the two transcribe.py invocations.
 *
 * Rules the owner set (2026-10-29): captions are clean text, so a dropped repeat, a hesitation or a
 * sentence-initial A / No / Tak is not a defect, and digits against number words is not an error; those
 * differences are never sent to the judge. The arbiter can only choose one of the two sides, and the
 * fine-tune wins on "neither", "same" or no answer.
 */
import { createHash } from "node:crypto";

/** One decoded segment as transcribe.py --both-models writes it. */
export interface DecodedSegment {
  start: number;
  end: number;
  text: string;
  language?: string;
  /** The padded VAD chunk the segment was decoded from: [start, end] in seconds. */
  chunk?: [number, number];
}

export interface BothDecodes {
  model?: string;
  baseModel?: string;
  language?: string;
  segments: DecodedSegment[];
  base: DecodedSegment[];
}

/** Differences closer together than this many words are one span. */
export const MERGE_GAP_WORDS = 3;
/** Words of context on each side of a span. */
export const CONTEXT_WORDS = 6;
/** Spans per Gemini call. */
export const BATCH_SIZE = 15;
/** A span with more words than this on a side is a rewrite or a hallucination, not a word-level disagreement. */
export const MAX_SPAN_WORDS = 25;
/** Audio around a span: its context words' range, padded (segment times are interpolated, so loose). */
const SNIPPET_PAD_S = 0.5;
const SNIPPET_MIN_S = 1.5;
const SNIPPET_MAX_S = 25;

export type Verdict = "ft" | "base" | "same" | "neither" | "none";

export type SkipReason = "repeat" | "filler" | "number" | "crossSegment" | "tooLong" | "formOnly";

export interface ArbiterSpan {
  id: string;
  /** Chunk key "start-end" */
  chunk: string;
  /** Index into the segment list of the fine-tune segment the span's words sit in (or follow) */
  segment: number;
  /** Word range [from, to) in the segment's own words; from == to is an insertion */
  from: number;
  to: number;
  /** The differing words on each side */
  ft: string;
  base: string;
  /** The same words with up to CONTEXT_WORDS around them, from each side's own text */
  ftContext: string;
  baseContext: string;
  /** Audio range (seconds) to listen to */
  t0: number;
  t1: number;
  /** Whether the judge saw the fine-tune as side A */
  ftIsA?: boolean;
  skipped?: SkipReason;
  verdict?: Verdict;
  said?: string;
  /** What the judge was told: the span went through Gemini */
  judged?: boolean;
}

/** Lower case, no punctuation, diacritics kept (the same normalisation the listening judge's diff uses). */
export function normalizeWord(w: string): string {
  return w.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const FILLERS = new Set(["e", "ee", "eee", "eh", "ehh", "ehm", "ehe", "hm", "hmm", "mm", "mhm", "uh", "um", "aha"]);
/** Words a clean caption may drop or keep at a sentence's start (owner, 2026-10-29). */
const SENTENCE_STARTERS = new Set(["a", "no", "tak", "ale", "aj", "ano", "ach"]);
const NUMBER_WORDS = new Set([
  "nula", "jeden", "jedna", "jedno", "dva", "dve", "tri", "styri", "pat", "sest", "sedem", "osem", "devat", "desat",
  "jedenast", "dvanast", "trinast", "strnast", "patnast", "sestnast", "sedemnast", "osemnast", "devatnast",
  "dvadsat", "tridsat", "strdsat", "styridsat", "patdesiat", "sestdesiat", "sedemdesiat", "osemdesiat", "devatdesiat",
  "sto", "dvesto", "tristo", "tisic", "milion", "ctyri", "pet", "sest", "sedm", "osm", "devet", "deset", "dvacet",
  "tricet", "ctyricet", "padesat", "sedesat", "sedmdesat", "osmdesat", "devadesat", "stovka",
]);

const stripDiacritics = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "");

function isNumberLike(w: string): boolean {
  return /^\d+$/.test(w) || NUMBER_WORDS.has(stripDiacritics(w));
}

interface ChunkWord {
  raw: string;
  norm: string;
  /** index into the fine-tune segment list */
  seg: number;
  /** index within the segment's words */
  at: number;
  start: number;
  end: number;
}

/** A segment's words with times spread over the segment by character count (no alignment has run yet). */
function segmentWords(seg: DecodedSegment, segIndex: number): ChunkWord[] {
  const toks = seg.text.split(/\s+/).filter(Boolean);
  const total = toks.reduce((n, t) => n + t.length + 1, 0) || 1;
  const dur = Math.max(0, seg.end - seg.start);
  let cum = 0;
  return toks.map((raw, at) => {
    const start = seg.start + (cum / total) * dur;
    cum += raw.length + 1;
    return { raw, norm: normalizeWord(raw), seg: segIndex, at, start, end: seg.start + (cum / total) * dur };
  });
}

export const chunkKey = (s: DecodedSegment): string => (s.chunk ? `${s.chunk[0]}-${s.chunk[1]}` : "");

type Op = { tag: "equal" | "replace" | "delete" | "insert"; i1: number; i2: number; j1: number; j2: number };

/** Longest-common-subsequence diff of two word lists (chunks are ~100 words, so the quadratic table is tiny). */
export function diffWords(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  const push = (tag: Op["tag"], i1: number, i2: number, j1: number, j2: number) => {
    const last = ops.at(-1);
    if (last && last.tag === tag && tag === "equal") { last.i2 = i2; last.j2 = j2; return; }
    ops.push({ tag, i1, i2, j1, j2 });
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push("equal", i, i + 1, j, j + 1); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { push("insert", i, i, j, j + 1); j++; }
    else { push("delete", i, i + 1, j, j); i++; }
  }
  // adjacent inserts/deletes are one replace
  const out: Op[] = [];
  for (const op of ops) {
    const last = out.at(-1);
    if (last && last.tag !== "equal" && op.tag !== "equal") {
      last.tag = "replace"; last.i2 = op.i2; last.j2 = op.j2;
    } else out.push({ ...op });
  }
  return out;
}

/** A span as indexes into the two word lists of one chunk. */
interface RawSpan { i1: number; i2: number; j1: number; j2: number }

/** The non-equal diff ops, with ones at most `gap` words apart (on both sides) joined into one span. */
export function mergedSpans(a: string[], b: string[], gap: number = MERGE_GAP_WORDS): RawSpan[] {
  const merged: RawSpan[] = [];
  for (const op of diffWords(a, b)) {
    if (op.tag === "equal") continue;
    const last = merged.at(-1);
    if (last && op.i1 - last.i2 <= gap && op.j1 - last.j2 <= gap) { last.i2 = op.i2; last.j2 = op.j2; }
    else merged.push({ i1: op.i1, i2: op.i2, j1: op.j1, j2: op.j2 });
  }
  return merged;
}

/** Drop fillers and collapse immediate repeats: what a clean caption would show of these words. */
function clean(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (FILLERS.has(w) || w === "") continue;
    if (out.at(-1) === w) continue;
    out.push(w);
  }
  return out;
}

/**
 * Why a difference is not worth a judge's ear, or null. Takes the normalised words of each side's core and of
 * the words around it on the side that is missing them.
 */
export function skipReason(ft: string[], base: string[], ftBefore: string[], ftAfter: string[], baseBefore: string[], baseAfter: string[]): SkipReason | null {
  if (ft.length > MAX_SPAN_WORDS || base.length > MAX_SPAN_WORDS) return "tooLong";
  const onlyFillers = (w: string[]) => w.every((x) => FILLERS.has(x));
  const onlyStarters = (w: string[]) => w.every((x) => FILLERS.has(x) || SENTENCE_STARTERS.has(x));
  if ((ft.length === 0 && onlyFillers(base)) || (base.length === 0 && onlyFillers(ft))) return "filler";
  // one side has extra words only: a sentence-initial A / No / Tak, or a word said twice
  if (ft.length === 0 || base.length === 0) {
    const extra = ft.length === 0 ? base : ft;
    if (onlyStarters(extra)) return "filler";
    const [before, after] = ft.length === 0 ? [ftBefore, ftAfter] : [baseBefore, baseAfter];
    const n = extra.length;
    if (n <= 3 && (extra.join(" ") === before.slice(-n).join(" ") || extra.join(" ") === after.slice(0, n).join(" "))) return "repeat";
  }
  const cf = clean(ft), cb = clean(base);
  if (cf.join(" ") === cb.join(" ")) return "repeat";
  // the base model wrote the same words without the accents the fine-tune has (it spells Slovak worse)
  const marks = (w: string[]) => (w.join(" ").normalize("NFD").match(/\p{M}/gu) ?? []).length;
  if (stripDiacritics(ft.join(" ")) === stripDiacritics(base.join(" ")) && marks(ft) > marks(base)) return "formOnly";
  // digits against number words
  const digits = (w: string[]) => w.some((x) => /\d/.test(x));
  if ((digits(ft) && !digits(base) && base.every(isNumberLike)) || (digits(base) && !digits(ft) && ft.every(isNumberLike))) return "number";
  if (ft.length && base.length && ft.every(isNumberLike) && base.every(isNumberLike) && ft.length === base.length && ft.join("") === base.join("")) return "number";
  return null;
}

export interface FindResult {
  spans: ArbiterSpan[];
  chunks: number;
  chunksCompared: number;
}

/**
 * Every span where the two decodes' normalised words differ inside the same chunk. A chunk only one decode
 * has (the other model's language routing, a decode the filters emptied) has no second opinion and is left alone.
 */
export function findSpans(segments: DecodedSegment[], base: DecodedSegment[]): FindResult {
  const baseByChunk = new Map<string, DecodedSegment[]>();
  for (const s of base) {
    const k = chunkKey(s);
    if (k) (baseByChunk.get(k) ?? baseByChunk.set(k, []).get(k)!).push(s);
  }
  const ftByChunk = new Map<string, number[]>();
  segments.forEach((s, i) => {
    const k = chunkKey(s);
    if (k) (ftByChunk.get(k) ?? ftByChunk.set(k, []).get(k)!).push(i);
  });

  const spans: ArbiterSpan[] = [];
  let compared = 0;
  for (const [key, segIdx] of ftByChunk) {
    const others = baseByChunk.get(key);
    if (!others?.length) continue;
    const ftWords = segIdx.flatMap((i) => segmentWords(segments[i], i));
    const bWords = others.flatMap((s) => segmentWords(s, -1));
    if (!ftWords.length || !bWords.length) continue;
    compared++;
    const fn = ftWords.map((w) => w.norm), bn = bWords.map((w) => w.norm);
    for (const sp of mergedSpans(fn, bn)) {
      const ftCore = ftWords.slice(sp.i1, sp.i2), baseCore = bWords.slice(sp.j1, sp.j2);
      const ftNorm = ftCore.map((w) => w.norm), baseNorm = baseCore.map((w) => w.norm);
      // where in the segments the span sits: its first word, or for an insertion the word before it
      const anchor = ftCore[0] ?? ftWords[sp.i1 - 1] ?? ftWords[sp.i1];
      const segOf = new Set(ftCore.map((w) => w.seg));
      const text = (ws: ChunkWord[]) => ws.map((w) => w.raw).join(" ");
      const c0 = Math.max(0, sp.i1 - CONTEXT_WORDS), c1 = Math.min(ftWords.length, sp.i2 + CONTEXT_WORDS);
      const d0 = Math.max(0, sp.j1 - CONTEXT_WORDS), d1 = Math.min(bWords.length, sp.j2 + CONTEXT_WORDS);
      const ctxWords = ftWords.slice(c0, c1);
      const t0 = Math.max(0, (ctxWords[0]?.start ?? anchor.start) - SNIPPET_PAD_S);
      let t1 = (ctxWords.at(-1)?.end ?? anchor.end) + SNIPPET_PAD_S;
      if (t1 - t0 < SNIPPET_MIN_S) t1 = t0 + SNIPPET_MIN_S;
      t1 = Math.min(t1, t0 + SNIPPET_MAX_S);
      const span: ArbiterSpan = {
        id: `${key}:${sp.i1}`,
        chunk: key,
        segment: anchor.seg,
        from: anchor.at + (ftCore.length ? 0 : (ftWords[sp.i1 - 1] ? 1 : 0)),
        to: anchor.at + (ftCore.length ? ftCore.length : (ftWords[sp.i1 - 1] ? 1 : 0)),
        ft: text(ftCore),
        base: text(baseCore),
        ftContext: text(ftWords.slice(c0, c1)),
        baseContext: text(bWords.slice(d0, d1)),
        t0: Math.round(t0 * 100) / 100,
        t1: Math.round(t1 * 100) / 100,
      };
      if (segOf.size > 1) span.skipped = "crossSegment";
      else {
        const reason = skipReason(
          ftNorm, baseNorm,
          fn.slice(Math.max(0, sp.i1 - 3), sp.i1), fn.slice(sp.i2, sp.i2 + 3),
          bn.slice(Math.max(0, sp.j1 - 3), sp.j1), bn.slice(sp.j2, sp.j2 + 3),
        );
        if (reason) span.skipped = reason;
      }
      spans.push(span);
    }
  }
  return { spans, chunks: ftByChunk.size, chunksCompared: compared };
}

/** Which side the judge sees as A: a fixed function of the span, so a re-run asks the same question (and hits the cache). */
export function ftIsSideA(span: Pick<ArbiterSpan, "id" | "ftContext" | "baseContext">, seed: string = ""): boolean {
  const h = createHash("md5").update(`${seed}|${span.id}|${span.ftContext}|${span.baseContext}`).digest();
  return (h[0] & 1) === 0;
}

/** The judge's letter, mapped back to a side. Anything but a clear A or B is the fine-tune ("neither", "same", no answer). */
export function verdictFor(answer: string | undefined, ftIsA: boolean): Verdict {
  if (answer === "A") return ftIsA ? "ft" : "base";
  if (answer === "B") return ftIsA ? "base" : "ft";
  if (answer === "same") return "same";
  if (answer === "neither") return "neither";
  return "none";
}

/** Fix the casing and closing punctuation the base words take over from the fine-tune's words they replace. */
function adopt(ftWords: string[], baseWords: string[], before: string | undefined): string[] {
  if (!baseWords.length) return baseWords;
  const out = [...baseWords];
  const startsSentence = before === undefined || /[.?!…]$/.test(before);
  if (ftWords.length && startsSentence && /^\p{Lu}/u.test(ftWords[0]) && /^\p{Ll}/u.test(out[0])) {
    out[0] = out[0][0].toUpperCase() + out[0].slice(1);
  }
  if (ftWords.length) {
    const tail = /[.?!…,;:]+$/.exec(ftWords.at(-1)!)?.[0];
    if (tail && !/[.?!…,;:]$/.test(out.at(-1)!)) out[out.length - 1] += tail;
  }
  return out;
}

/**
 * The fine-tune's segments with every span the judge gave to the base model replaced by the base model's words.
 * Nothing else changes: spans with any other verdict, skipped or unjudged, keep the fine-tune's text.
 */
export function applyVerdicts(segments: DecodedSegment[], spans: ArbiterSpan[]): DecodedSegment[] {
  const bySegment = new Map<number, ArbiterSpan[]>();
  for (const sp of spans) {
    if (sp.verdict !== "base" || sp.skipped) continue;
    (bySegment.get(sp.segment) ?? bySegment.set(sp.segment, []).get(sp.segment)!).push(sp);
  }
  return segments.map((seg, i) => {
    const edits = bySegment.get(i);
    const out: DecodedSegment = { start: seg.start, end: seg.end, text: seg.text, ...(seg.language ? { language: seg.language } : {}) };
    if (!edits) return out;
    const words = seg.text.split(/\s+/).filter(Boolean);
    for (const sp of [...edits].sort((a, b) => b.from - a.from)) {
      // clean text: the base model's hesitations and repeats (also of the word before the span) never come in
      let prev = normalizeWord(words[sp.from - 1] ?? "");
      const incoming = sp.base.split(/\s+/).filter(Boolean).filter((w) => {
        const n = normalizeWord(w);
        if (FILLERS.has(n) || (n !== "" && n === prev)) return false;
        prev = n;
        return true;
      });
      const replacement = adopt(words.slice(sp.from, sp.to), incoming, words[sp.from - 1]);
      const dropped = words.slice(sp.from, sp.to);
      words.splice(sp.from, sp.to - sp.from, ...replacement);
      // a deleted tail takes its closing punctuation with it: it moves to the word before
      if (!replacement.length && sp.from > 0 && dropped.length) {
        const tail = /[.?!…,;:]+$/.exec(dropped.at(-1)!)?.[0];
        if (tail && !/[.?!…,;:]$/.test(words[sp.from - 1])) words[sp.from - 1] += tail;
      }
    }
    out.text = words.join(" ");
    return out;
  });
}

export interface ArbiterSummary {
  /** Spans found where the decodes' normalised words differ */
  spans: number;
  skipped: Partial<Record<SkipReason, number>>;
  judged: number;
  chose: { ft: number; base: number; same: number; neither: number; none: number };
  batches: number;
  /** Gemini requests made, retries included (cache hits excluded) */
  calls: number;
  cacheHits: number;
  audioSeconds: number;
}

export function summarize(spans: ArbiterSpan[], extra: Pick<ArbiterSummary, "batches" | "calls" | "cacheHits">): ArbiterSummary {
  const skipped: Partial<Record<SkipReason, number>> = {};
  const chose = { ft: 0, base: 0, same: 0, neither: 0, none: 0 };
  let judged = 0, audio = 0;
  for (const s of spans) {
    if (s.skipped) { skipped[s.skipped] = (skipped[s.skipped] ?? 0) + 1; continue; }
    if (!s.judged) continue;
    judged++;
    audio += s.t1 - s.t0;
    chose[s.verdict ?? "none"]++;
  }
  return { spans: spans.length, skipped, judged, chose, ...extra, audioSeconds: Math.round(audio) };
}
