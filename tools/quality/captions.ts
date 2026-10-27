// YouTube json3 auto-captions -> clean word-timed SRT.
// YouTube repeats each line in a rolling window (and the VTT conversion keeps the duplicates),
// so the words are rebuilt from events[].segs[] and de-duplicated by time before grouping into cues.
// The input is untrusted data: it is only ever parsed with JSON.parse, never executed.

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

export interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;
const MAX_GAP_MS = 1000;
const MAX_CUE_MS = 7000;
const MAX_WORD_MS = 1500;
const HOLD_MS = 300;

/** Words of a json3 document: tStartMs + tOffsetMs per segment, text from utf8. */
export function json3ToWords(json: unknown): Word[] {
  const events: Json3Event[] = Array.isArray((json as { events?: unknown })?.events)
    ? ((json as { events: Json3Event[] }).events)
    : [];
  const raw: Word[] = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
    const base = Number(ev.tStartMs);
    if (!Number.isFinite(base)) continue;
    const evEnd = base + (Number(ev.dDurationMs) || 0);
    const evWords: Word[] = [];
    for (const seg of ev.segs) {
      const utf8 = typeof seg?.utf8 === 'string' ? seg.utf8 : '';
      const text = utf8.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const startMs = base + (Number(seg.tOffsetMs) || 0);
      // A segment without a leading space continues the previous word (not the first of an event).
      if (evWords.length > 0 && !/^\s/.test(utf8)) {
        evWords[evWords.length - 1]!.text += text;
        continue;
      }
      evWords.push({ text, startMs, endMs: startMs });
    }
    evWords.forEach((w, i) => {
      const next = evWords[i + 1];
      const end = next ? next.startMs : evEnd > w.startMs ? evEnd : w.startMs + 400;
      w.endMs = Math.min(end, w.startMs + MAX_WORD_MS);
    });
    raw.push(...evWords);
  }
  return dedupeWords(raw);
}

/** Sort by time and drop rolling-window repeats: same text starting within 400 ms of a kept word. */
export function dedupeWords(words: Word[]): Word[] {
  const sorted = [...words].sort((a, b) => a.startMs - b.startMs);
  const kept: Word[] = [];
  for (const w of sorted) {
    const recent = kept.slice(-6);
    if (recent.some((k) => k.text === w.text && Math.abs(k.startMs - w.startMs) < 400)) continue;
    kept.push({ ...w });
  }
  // No overlaps: a word ends no later than the next begins.
  for (let i = 0; i < kept.length - 1; i++) {
    kept[i]!.endMs = Math.min(kept[i]!.endMs, Math.max(kept[i + 1]!.startMs, kept[i]!.startMs + 1));
  }
  return kept;
}

/** Group words into cues of up to 2 lines of 42 characters, split on pauses and cue length. */
export function wordsToCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const lines = wrapLines(cur.map((w) => w.text));
    cues.push({ startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs, lines });
    cur = [];
  };
  for (const w of words) {
    if (cur.length > 0) {
      const last = cur[cur.length - 1]!;
      const gap = w.startMs - last.endMs;
      const tooLong = w.endMs - cur[0]!.startMs > MAX_CUE_MS;
      const overflow = wrapLines([...cur.map((c) => c.text), w.text]).length > MAX_LINES;
      if (gap > MAX_GAP_MS || tooLong || overflow) flush();
    }
    cur.push(w);
  }
  flush();
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const limit = i + 1 < cues.length ? cues[i + 1]!.startMs : Infinity;
    c.endMs = Math.max(c.startMs + 1, Math.min(c.endMs + HOLD_MS, limit));
  }
  return cues;
}

function wrapLines(words: string[]): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > MAX_LINE_CHARS) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function formatTimestamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(t % 1000, 3)}`;
}

export function cuesToSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.startMs)} --> ${formatTimestamp(c.endMs)}\n${c.lines.join('\n')}\n`)
    .join('\n');
}

export function json3ToSrt(json: unknown): { srt: string; cues: Cue[]; words: number } {
  const words = json3ToWords(json);
  const cues = wordsToCues(words);
  return { srt: cuesToSrt(cues), cues, words: words.length };
}
