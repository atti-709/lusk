import { describe, expect, it } from 'vitest';
import { cuesToSrt, formatTimestamp, json3ToSrt, json3ToWords, wordsToCues } from './captions';

const doc = {
  events: [
    { tStartMs: 0, dDurationMs: 100000, id: 1 }, // window definition: no segs
    {
      tStartMs: 1000,
      dDurationMs: 3000,
      segs: [{ utf8: 'Amen.' }, { utf8: ' Môžeme', tOffsetMs: 500 }, { utf8: ' zatlieskať', tOffsetMs: 900 }],
    },
    { tStartMs: 3990, aAppend: 1, segs: [{ utf8: '\n' }] },
    // rolling-window repeat of the previous words, then new ones
    {
      tStartMs: 1000,
      dDurationMs: 4000,
      segs: [{ utf8: 'Amen.' }, { utf8: ' Môžeme', tOffsetMs: 500 }, { utf8: ' zatlieskať', tOffsetMs: 900 }, { utf8: ' Pánovi.', tOffsetMs: 1500 }],
    },
  ],
};

describe('json3ToWords', () => {
  it('skips events without segs or with aAppend and drops rolling-window repeats', () => {
    const words = json3ToWords(doc);
    expect(words.map((w) => w.text)).toEqual(['Amen.', 'Môžeme', 'zatlieskať', 'Pánovi.']);
    expect(words.map((w) => w.startMs)).toEqual([1000, 1500, 1900, 2500]);
  });

  it('uses tStartMs plus the per-segment offset and keeps words monotonic and non-overlapping', () => {
    const words = json3ToWords(doc);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.startMs).toBeGreaterThan(words[i - 1]!.startMs);
      expect(words[i - 1]!.endMs).toBeLessThanOrEqual(words[i]!.startMs);
    }
  });

  it('joins a segment without a leading space to the previous word', () => {
    const words = json3ToWords({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Slo' }, { utf8: 'vensko', tOffsetMs: 200 }] }] });
    expect(words.map((w) => w.text)).toEqual(['Slovensko']);
  });

  it('tolerates malformed input', () => {
    expect(json3ToWords(null)).toEqual([]);
    expect(json3ToWords({ events: 'x' })).toEqual([]);
    expect(json3ToWords({ events: [null, { tStartMs: 'a', segs: [{ utf8: 'x' }] }] })).toEqual([]);
  });
});

describe('wordsToCues', () => {
  it('wraps at 42 chars into at most two lines and splits on pauses', () => {
    const w = (text: string, startMs: number) => ({ text, startMs, endMs: startMs + 200 });
    const words = [];
    for (let i = 0; i < 20; i++) words.push(w('slovenčina', i * 250));
    words.push(w('po pauze', 20000));
    const cues = wordsToCues(words);
    expect(cues.length).toBeGreaterThan(2);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(42);
    }
    expect(cues[cues.length - 1]!.lines).toEqual(['po pauze']);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.startMs).toBeGreaterThanOrEqual(cues[i - 1]!.endMs);
  });
});

describe('srt output', () => {
  it('formats timestamps and numbers cues without repeated lines', () => {
    expect(formatTimestamp(3723456)).toBe('01:02:03,456');
    const { srt, cues } = json3ToSrt(doc);
    expect(srt.startsWith('1\n00:00:01,000 --> ')).toBe(true);
    expect(cues).toHaveLength(1);
    expect(srt.match(/Amen\./g)).toHaveLength(1);
    expect(cuesToSrt([])).toBe('');
  });
});
