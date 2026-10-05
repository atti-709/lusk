/**
 * Clip boundaries on the transcript's words: where a clip may start and where to cut it.
 * Pure (no server state), so the episode batch script applies the same rules to stored clips.
 */
import type { TranscriptWord } from "@lusk/shared";

/** How far a Gemini timestamp may sit from a real word boundary and still be snapped to it. */
export const SNAP_TOLERANCE_MS = 2000;

/** The word boundary nearest to `ms`, or `ms` itself when none is within tolerance. */
export function snapToWordStart(ms: number, words: TranscriptWord[]): number {
  let best = ms;
  let bestDist = SNAP_TOLERANCE_MS;
  for (const w of words) {
    const d = Math.abs(w.startMs - ms);
    if (d < bestDist) { best = w.startMs; bestDist = d; }
    if (w.startMs > ms + SNAP_TOLERANCE_MS) break;
  }
  return best;
}

const endsSentence = (word: string) => /[.!?…]["“”»)]*$/.test(word);

/** How far back a clip that starts mid-sentence may be moved to that sentence's start. */
const SENTENCE_LOOKBACK_MS = 10_000;
/** A silence this long is a boundary in itself (and may hide speech the transcript lost). */
const BOUNDARY_PAUSE_MS = 1500;

/**
 * A start Gemini placed mid-sentence (a lowercase word after one with no full stop) moves
 * back to where that sentence begins, if that is close. Capitalized starts are left alone:
 * unscripted transcripts often miss the full stop before a real sentence start.
 */
export function startAtSentence(startMs: number, words: TranscriptWord[]): number {
  const i = words.findIndex((w) => w.startMs >= startMs);
  if (i <= 0 || words[i].startMs !== startMs) return startMs;
  const first = words[i].word.replace(/^[^\p{L}\d]+/u, "");
  if (endsSentence(words[i - 1].word) || first[0] !== first[0]?.toLowerCase() || /^\d/.test(first)) return startMs;
  for (let k = i - 1; k >= 0 && words[k].startMs >= startMs - SENTENCE_LOOKBACK_MS; k--) {
    if (words[k + 1].startMs - words[k].endMs > BOUNDARY_PAUSE_MS) return words[k + 1].startMs;
    if (k === 0 || endsSentence(words[k - 1].word)) return words[k].startMs;
  }
  return startMs;
}

/** How early a clip may start before its first word: aligned word starts run ~0.1 s late. */
const LEAD_IN_MS = 200;
/** Silence kept between the previous word and the lead-in, so none of that word is heard. */
const PREV_WORD_GUARD_MS = 100;

/**
 * Start slightly before the first word, inside the pause before it, so its first syllable
 * isn't clipped. Only a start sitting exactly on a word moves, so applying it twice is safe.
 * Corrected transcripts end each word where the next starts — no measurable pause, no lead.
 */
export function leadIn(startMs: number, words: TranscriptWord[]): number {
  const i = words.findIndex((w) => w.startMs >= startMs);
  if (i < 0 || words[i].startMs !== startMs) return startMs;
  const pauseStart = i > 0 ? words[i - 1].endMs + PREV_WORD_GUARD_MS : 0;
  return Math.max(0, Math.min(startMs, Math.max(startMs - LEAD_IN_MS, pauseStart)));
}

/** Breath kept after a clip's closing word, never reaching into the next word. */
const END_BREATH_MS = 400;
const NEXT_WORD_GUARD_MS = 60;

/**
 * Where to cut a clip whose end Gemini gave as the next word's start: just after the
 * closing word (the one before it) — the pause between sentences is otherwise dead air,
 * and anything past the next word's start plays a sentence the clip never finishes.
 */
export function cutAfterClosingWord(nextWordStartMs: number, words: TranscriptWord[]): number {
  let i = words.findIndex((w) => w.startMs >= nextWordStartMs);
  if (i <= 0) return nextWordStartMs;
  // Gemini sometimes points at the sentence's own last word ("… Ježiš je | Pán.") — keep it
  if (!endsSentence(words[i - 1].word) && endsSentence(words[i].word)) i++;
  if (i >= words.length) return words[i - 1].endMs;
  // Corrected transcripts end each word where the next starts, so the guard decides there
  const closing = words[i - 1];
  const cut = Math.min(closing.endMs + END_BREATH_MS, words[i].startMs - NEXT_WORD_GUARD_MS);
  return Math.max(cut, closing.startMs + 1);
}
