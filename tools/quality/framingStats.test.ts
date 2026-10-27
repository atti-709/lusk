import { describe, expect, it } from 'vitest';
import { cutsPerMinute, distribution, faceStats, fitPercent, fitSeconds, histogram, rangeStarts } from './framingStats';

describe('fit time', () => {
  it('unions overlapping ranges and clips them to the span', () => {
    expect(fitSeconds([[0, 10], [5, 15], [40, 60]], 45)).toBe(20);
    expect(fitSeconds([[3, 3]], 45)).toBe(0);
  });
  it('is a percent of the span', () => {
    expect(fitPercent([[0, 9, 0.2, 0.8]], 45)).toBeCloseTo(20);
    expect(fitPercent([], 0)).toBe(0);
  });
});

describe('cuts per minute', () => {
  it('scales to the span', () => {
    expect(cutsPerMinute([1, 2, 3], 45)).toBeCloseTo(4);
    expect(cutsPerMinute([], 45)).toBe(0);
  });
});

describe('distribution and histogram', () => {
  it('takes min, median (even and odd) and max', () => {
    expect(distribution([0.3, 0.1, 0.2])).toEqual({ n: 3, min: 0.1, median: 0.2, max: 0.3 });
    expect(distribution([0.1, 0.2, 0.3, 0.4]).median).toBeCloseTo(0.25);
    expect(distribution([]).median).toBeNull();
  });
  it('puts edge values in the upper bin and keeps the last bin open', () => {
    const h = histogram([0.01, 0.02, 0.099, 0.1, 0.9]);
    expect(h[0]).toBe(1);
    expect(h[1]).toBe(1);
    expect(h[4]).toBe(1);
    expect(h[5]).toBe(1);
    expect(h[9]).toBe(1);
  });
});

describe('face stats', () => {
  const face = (h: number, conf = 0.9) => ({ x: 0.4, y: 0.2, w: h, h, conf });
  it('counts frames without a confident face and frames under the fit minimum', () => {
    const s = faceStats({
      sampleHz: 10,
      detectWidth: 1440,
      faceMinConfidence: 0.3,
      fitFaceMinH: 0.1,
      frames: [
        { t: 0, faces: [face(0.2), face(0.05)], text: [] },
        { t: 0.1, faces: [face(0.06)], text: [[0, 1], [0, 1], [0, 1]] },
        { t: 0.2, faces: [face(0.2, 0.1)], text: [] },
        { t: 0.3, faces: [], text: [] },
      ],
    });
    expect(s.frames).toBe(4);
    expect(s.framesNoFace).toBe(2);
    expect(s.framesLowConfOnly).toBe(1);
    expect(s.framesBelowFitMin).toBe(3);
    expect(s.framesTextHeavy).toBe(1);
    expect(s.biggest.n).toBe(2);
    expect(s.biggest.median).toBeCloseTo(0.13);
    expect(s.all.n).toBe(3);
  });
});

describe('range starts', () => {
  it('uses minutes 5, 15, 25', () => {
    expect(rangeStarts(3000)).toEqual([300, 900, 1500]);
  });
  it('clamps into a short video and drops duplicates', () => {
    expect(rangeStarts(1000)).toEqual([300, 900, 955]);
    expect(rangeStarts(600)).toEqual([300, 555]);
    expect(rangeStarts(100)).toEqual([55]);
  });
});
