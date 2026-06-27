// Config advisor (V1b) — runAdvisor orchestration unit tests. Pure: synthetic
// candles of a known regime in, ranked recommendations out. No network.

import { describe, it, expect } from 'vitest';
import { runAdvisor, robustnessVerdict } from '../src/bot/advisor.js';
import type { BacktestCandle } from '../src/bot/backtester.js';
import type { RobustnessStats } from '../src/bot/robustness.js';

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
  it('does not flag a ranging market as no_go, and returns ranked configs', () => {
    const r = runAdvisor(rangingCandles(), { pair: 'X', direction: 'long', investmentUSDT: 1000, leverage: 3 })!;
    expect(r).not.toBeNull();
    expect(r.regime.state).toBe('range');
    // Favorable regime → verdict is recommend or caution (depends on the
    // backtest evidence), but NEVER no_go.
    expect(r.verdict).not.toBe('no_go');
    expect(['favorable', 'weak_backtest', 'regime_with_trend']).toContain(r.verdictReason);
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
    expect(r.verdictReason).toBe('regime_against');
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

// The fix for the production trap: a choppy −33% market got classified "range"
// (low efficiency ratio) so the regime gate said "recommend", yet every
// candidate LOST in every window. robustnessVerdict overrides the heuristic
// with the backtest evidence.
describe('robustnessVerdict (evidence overrides regime)', () => {
  const stats = (over: Partial<RobustnessStats>): RobustnessStats => ({
    meanRetPct: 5, medianRetPct: 5, worstRetPct: -3, bestRetPct: 12,
    winRatePct: 80, worstMaxDrawdownPct: 8, windows: 3, ...over,
  });

  it('no_go when the best candidate loses on average / never wins (the prod case)', () => {
    // The exact shape seen live: mean −1.9%, 0% windows positive.
    expect(robustnessVerdict(stats({ meanRetPct: -1.9, winRatePct: 0, worstRetPct: -5.8 }))).toBe('no_go');
    expect(robustnessVerdict(stats({ meanRetPct: 0 }))).toBe('no_go');
  });

  it('caution when marginal (low win-rate / deep worst-case / low confidence)', () => {
    expect(robustnessVerdict(stats({ meanRetPct: 2, winRatePct: 40 }))).toBe('caution');
    expect(robustnessVerdict(stats({ meanRetPct: 2, worstRetPct: -25 }))).toBe('caution');
  });

  it('recommend only when the evidence is genuinely strong', () => {
    expect(robustnessVerdict(stats({ meanRetPct: 6, winRatePct: 80, worstRetPct: -4 }))).toBe('recommend');
  });

  it('caution (not recommend) when there is no scoring at all', () => {
    expect(robustnessVerdict(undefined)).toBe('caution');
  });
});
