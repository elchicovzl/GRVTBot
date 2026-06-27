// Config advisor (V1a) — robustness scoring unit tests. Deterministic, no I/O.

import { describe, it, expect } from 'vitest';
import {
  aggregateWindows, compareRobustness, confidenceBucket, type RobustnessStats,
} from '../src/bot/robustness.js';

describe('aggregateWindows', () => {
  it('computes mean/median/worst/best/win-rate/worst-DD', () => {
    const s = aggregateWindows([
      { retPct: 10, maxDDPct: 5 },
      { retPct: -4, maxDDPct: 20 },
      { retPct: 8, maxDDPct: 8 },
    ])!;
    expect(s.meanRetPct).toBeCloseTo(4.6667, 3);
    expect(s.medianRetPct).toBe(8);
    expect(s.worstRetPct).toBe(-4);
    expect(s.bestRetPct).toBe(10);
    expect(s.winRatePct).toBeCloseTo(66.6667, 3); // 2 of 3 positive
    expect(s.worstMaxDrawdownPct).toBe(20);
    expect(s.windows).toBe(3);
  });
  it('returns null for empty input', () => {
    expect(aggregateWindows([])).toBeNull();
  });
});

describe('compareRobustness', () => {
  const mk = (worst: number, win: number, mean: number): RobustnessStats => ({
    meanRetPct: mean, medianRetPct: mean, worstRetPct: worst, bestRetPct: mean,
    winRatePct: win, worstMaxDrawdownPct: 0, windows: 3,
  });

  it('ranks the better worst-case first (survival over peak)', () => {
    // A has worse mean but a much better worst-case → A wins.
    const A = mk(-5, 60, 6);
    const B = mk(-40, 67, 20);
    expect([B, A].sort(compareRobustness)[0]).toBe(A);
  });

  it('breaks worst-case ties by win-rate', () => {
    const A = mk(-10, 80, 5);
    const B = mk(-10, 50, 9);
    expect([B, A].sort(compareRobustness)[0]).toBe(A);
  });
});

describe('confidenceBucket', () => {
  const mk = (win: number, worst: number): RobustnessStats => ({
    meanRetPct: 0, medianRetPct: 0, worstRetPct: worst, bestRetPct: 0,
    winRatePct: win, worstMaxDrawdownPct: 0, windows: 3,
  });

  it('is high only with strong win-rate AND shallow worst-case', () => {
    expect(confidenceBucket(mk(80, -5))).toBe('high');
  });
  it('drops a high win-rate with a deep worst-case down to low', () => {
    // win 80 but worst -30: fails high (worst <= -10) and med (worst <= -25) → low.
    expect(confidenceBucket(mk(80, -30))).toBe('low');
  });
  it('is med in the middle band', () => {
    expect(confidenceBucket(mk(60, -15))).toBe('med');
  });
  it('is low for weak win-rate', () => {
    expect(confidenceBucket(mk(40, -5))).toBe('low');
  });
});
