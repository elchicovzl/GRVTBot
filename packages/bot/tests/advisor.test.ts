// Config advisor (V1b) — runAdvisor orchestration unit tests. Pure: synthetic
// candles of a known regime in, ranked recommendations out. No network.

import { describe, it, expect } from 'vitest';
import { runAdvisor } from '../src/bot/advisor.js';
import type { BacktestCandle } from '../src/bot/backtester.js';

const H4 = 14400; // 4h in seconds

// Oscillates 95..105 around 100 → low ER → range (grid-friendly).
function rangingCandles(n = 120): BacktestCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + 5 * Math.sin(i / 3);
    return { time: i * H4, open: close, high: close + 1, low: close - 1, close };
  });
}

// Steady decline 200 → ~81 → high ER, negative slope → trend_down.
function downtrendCandles(n = 120): BacktestCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 200 - i;
    return { time: i * H4, open: close, high: close + 1, low: close - 1, close };
  });
}

describe('runAdvisor', () => {
  it('recommends in a ranging market and returns ranked configs', () => {
    const r = runAdvisor(rangingCandles(), { pair: 'X', direction: 'long', investmentUSDT: 1000, leverage: 3 })!;
    expect(r).not.toBeNull();
    expect(r.regime.state).toBe('range');
    expect(r.verdict).toBe('recommend');
    expect(r.recommendations.length).toBeGreaterThan(0);

    const top = r.recommendations[0]!;
    expect(top.rank).toBe(1);
    expect(top.config.direction).toBe('long');
    expect(top.config.numGrids).toBeGreaterThanOrEqual(2);
    expect(['high', 'med', 'low']).toContain(top.confidence);
    expect(top.reasonCodes.some((c) => c.startsWith('regime:'))).toBe(true);
    expect(top.equityCurve!.length).toBeGreaterThan(0); // rank 1 carries the curve
    expect(top.robustness.windows).toBe(3);

    // Ranking is by robustness: the top's worst-case is >= the runner-up's.
    if (r.recommendations[1]) {
      expect(top.robustness.worstRetPct).toBeGreaterThanOrEqual(r.recommendations[1].robustness.worstRetPct);
    }
    // Honest assumptions surfaced.
    expect(r.assumptions.fundingModel).toMatch(/no historical funding/i);
    expect(r.assumptions.candidatesEvaluated).toBeGreaterThan(0);
  });

  it('returns a no_go verdict for a long grid in a downtrend', () => {
    const r = runAdvisor(downtrendCandles(), { pair: 'X', direction: 'long', investmentUSDT: 1000, leverage: 3 })!;
    expect(r.regime.state).toBe('trend_down');
    expect(r.verdict).toBe('no_go');
    // It still returns analysis (the gate is advisory, not a hard block).
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it('a short grid in the same downtrend is caution, not no_go', () => {
    const r = runAdvisor(downtrendCandles(), { pair: 'X', direction: 'short', investmentUSDT: 1000, leverage: 3 })!;
    expect(r.verdict).toBe('caution');
  });

  it('uses the user range when provided (source=user appears)', () => {
    const r = runAdvisor(rangingCandles(), {
      pair: 'X', direction: 'long', investmentUSDT: 1000, leverage: 3,
      lowerPrice: 96, upperPrice: 104,
    })!;
    const sources = r.recommendations.map((x) => x.config.rangeSource);
    expect(sources).toContain('user');
  });

  it('returns null with insufficient candle history', () => {
    expect(runAdvisor(rangingCandles(10), { pair: 'X', direction: 'long', investmentUSDT: 1000, leverage: 3 })).toBeNull();
  });
});
