// Config advisor (V1a) — regime detection unit tests. Deterministic, no I/O.

import { describe, it, expect } from 'vitest';
import {
  efficiencyRatio, linregSlope, classifyRegime, gridVerdict,
} from '../src/bot/regime.js';

describe('efficiencyRatio (Kaufman)', () => {
  it('is 1 for a perfectly directional path', () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5])).toBeCloseTo(1, 9); // net 4 / path 4
  });
  it('is 0 for a pure zigzag that returns to start', () => {
    expect(efficiencyRatio([1, 2, 1, 2, 1])).toBeCloseTo(0, 9); // net 0
  });
  it('is 0 for a flat path (no movement → no trend)', () => {
    expect(efficiencyRatio([5, 5, 5])).toBe(0);
  });
  it('matches a hand-computed partial value', () => {
    // net |13-10| = 3 ; path 1+1+3 = 5 → 0.6
    expect(efficiencyRatio([10, 11, 10, 13])).toBeCloseTo(0.6, 9);
  });
  it('returns null with fewer than 2 points', () => {
    expect(efficiencyRatio([1])).toBeNull();
  });
});

describe('linregSlope', () => {
  it('is +1 per bar for a unit up-ramp', () => {
    expect(linregSlope([1, 2, 3, 4, 5])).toBeCloseTo(1, 9);
  });
  it('is -1 per bar for a unit down-ramp', () => {
    expect(linregSlope([5, 4, 3, 2, 1])).toBeCloseTo(-1, 9);
  });
  it('returns null with fewer than 2 points', () => {
    expect(linregSlope([1])).toBeNull();
  });
});

describe('classifyRegime', () => {
  it('flags a strong up-move as trend_up', () => {
    const r = classifyRegime([100, 110, 120, 130, 140])!;
    expect(r.state).toBe('trend_up');
    expect(r.efficiencyRatio).toBeCloseTo(1, 9);
    expect(r.trendPct).toBeGreaterThan(5);
  });
  it('flags a strong down-move as trend_down', () => {
    expect(classifyRegime([140, 130, 120, 110, 100])!.state).toBe('trend_down');
  });
  it('treats a zigzag as range (low ER)', () => {
    expect(classifyRegime([100, 105, 100, 105, 100])!.state).toBe('range');
  });
  it('treats a directional-but-tiny drift as range (below slopeMinPct)', () => {
    // monotonic but only ~3% over the window → ER=1 yet not "trending".
    expect(classifyRegime([100, 101, 102, 103])!.state).toBe('range');
  });
  it('respects custom thresholds', () => {
    // Lower slopeMinPct so the 3% drift now counts as a trend.
    expect(classifyRegime([100, 101, 102, 103], { slopeMinPct: 1 })!.state).toBe('trend_up');
  });
});

describe('gridVerdict', () => {
  it('blocks a long grid in a downtrend, allows it in a range', () => {
    expect(gridVerdict('trend_down', 'long')).toBe('no_go');
    expect(gridVerdict('trend_up', 'long')).toBe('caution');
    expect(gridVerdict('range', 'long')).toBe('recommend');
  });
  it('mirrors for a short grid', () => {
    expect(gridVerdict('trend_up', 'short')).toBe('no_go');
    expect(gridVerdict('trend_down', 'short')).toBe('caution');
    expect(gridVerdict('range', 'short')).toBe('recommend');
  });
});
