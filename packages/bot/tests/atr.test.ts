// #8 ATR-based grid spacing — pure unit tests for the ATR computation and the
// spacing/num_grids derivation. No network, no DB: deterministic by design.

import { describe, it, expect } from 'vitest';
import { computeATR, deriveAtrSpacing, type AtrCandle } from '../src/bot/atr.js';

// Build a candle whose true range is exactly `tr` given the previous close.
// high = prevClose + tr/2, low = prevClose - tr/2, close = prevClose →
// high-low = tr, |high-prevClose| = tr/2, |low-prevClose| = tr/2 → TR = tr.
function candleWithTR(prevClose: number, tr: number, close = prevClose): AtrCandle {
  return { high: prevClose + tr / 2, low: prevClose - tr / 2, close };
}

describe('computeATR (Wilder)', () => {
  it('returns the constant value when every true range is identical', () => {
    // 20 candles, each TR = 10 → ATR = 10 regardless of period/smoothing.
    const candles: AtrCandle[] = [{ high: 105, low: 95, close: 100 }];
    for (let i = 0; i < 20; i++) candles.push(candleWithTR(100, 10));
    expect(computeATR(candles, 14)).toBeCloseTo(10, 9);
  });

  it('matches a hand-computed Wilder smoothing (period 2, TR = [10,20,30])', () => {
    // seed = SMA(10,20) = 15 ; smooth with 30 → (15*1 + 30)/2 = 22.5
    const candles: AtrCandle[] = [
      { high: 105, low: 95, close: 100 }, // c0: only its close (100) is used as prevClose
      { high: 105, low: 95, close: 100 }, // TR1 = max(10, 5, 5) = 10
      { high: 120, low: 100, close: 110 }, // prevClose 100 → max(20, 20, 0) = 20
      { high: 140, low: 110, close: 130 }, // prevClose 110 → max(30, 30, 0) = 30
    ];
    expect(computeATR(candles, 2)).toBeCloseTo(22.5, 9);
  });

  it('returns null when there are fewer than period+1 candles', () => {
    const candles: AtrCandle[] = Array.from({ length: 14 }, () => ({ high: 105, low: 95, close: 100 }));
    expect(computeATR(candles, 14)).toBeNull(); // need 15 for period 14
  });

  it('returns null on a non-finite value or an invalid period', () => {
    const bad: AtrCandle[] = [
      { high: 105, low: 95, close: 100 },
      { high: NaN, low: 95, close: 100 },
      { high: 105, low: 95, close: 100 },
    ];
    expect(computeATR(bad, 1)).toBeNull();
    expect(computeATR([{ high: 1, low: 1, close: 1 }, { high: 2, low: 1, close: 1 }], 0)).toBeNull();
  });
});

describe('deriveAtrSpacing', () => {
  // Range [900, 1100], mid = 1000. Fee floor = minProfitableSpacing(1000)/1000
  // = 2*1000*0.0005*1.5 / 1000 * 100 = 0.15%. minSpacingPct default 1.0% wins.
  const LOWER = 900;
  const UPPER = 1100;

  function flatCandles(tr: number, n = 30): AtrCandle[] {
    const c: AtrCandle[] = [{ high: 1005, low: 995, close: 1000 }];
    for (let i = 0; i < n; i++) c.push(candleWithTR(1000, tr));
    return c;
  }

  it('derives spacing and num_grids when k×ATR% lands between floor and cap', () => {
    // TR=30 → ATR=30 → atrPct=3.0% ; k=0.6 → rawSpacing 1.8% (in [1%,4%]).
    const r = deriveAtrSpacing(flatCandles(30), LOWER, UPPER, { multiplier: 0.6 })!;
    expect(r.atr).toBeCloseTo(30, 6);
    expect(r.atrPct).toBeCloseTo(3.0, 6);
    expect(r.rawSpacingPct).toBeCloseTo(1.8, 6);
    expect(r.spacingPct).toBeCloseTo(1.8, 6);
    expect(r.clampedAtFloor).toBe(false);
    expect(r.clampedAtCap).toBe(false);
    // spacingAbs = 1.8% * 1000 = 18 ; numGrids = round(200/18) = 11
    expect(r.spacingAbs).toBeCloseTo(18, 6);
    expect(r.numGrids).toBe(11);
  });

  it('clamps UP to the floor in low volatility', () => {
    // TR=5 → atrPct=0.5% ; k=0.6 → 0.3% < 1.0% floor → clamped to 1.0%.
    const r = deriveAtrSpacing(flatCandles(5), LOWER, UPPER, { multiplier: 0.6 })!;
    expect(r.clampedAtFloor).toBe(true);
    expect(r.spacingPct).toBeCloseTo(1.0, 6);
    // spacingAbs = 10 ; numGrids = round(200/10) = 20
    expect(r.numGrids).toBe(20);
  });

  it('clamps DOWN to the cap in high volatility', () => {
    // TR=100 → atrPct=10% ; k=0.6 → 6% > 4% cap → clamped to 4%.
    const r = deriveAtrSpacing(flatCandles(100), LOWER, UPPER, { multiplier: 0.6 })!;
    expect(r.clampedAtCap).toBe(true);
    expect(r.spacingPct).toBeCloseTo(4.0, 6);
    // spacingAbs = 40 ; numGrids = round(200/40) = 5
    expect(r.numGrids).toBe(5);
  });

  it('lets the fee floor override a too-low minSpacingPct (single source of truth)', () => {
    // minSpacingPct lowered to 0.05%, but k×ATR (0.12%) is below the 0.15% fee
    // floor → spacing is pinned at the fee floor, not the user's 0.05%.
    // TR=2 → atrPct=0.2% ; k=0.6 → 0.12%.
    const r = deriveAtrSpacing(flatCandles(2), LOWER, UPPER, { multiplier: 0.6, minSpacingPct: 0.05 })!;
    expect(r.floorPct).toBeCloseTo(0.15, 6);
    expect(r.clampedAtFloor).toBe(true);
    expect(r.spacingPct).toBeCloseTo(0.15, 6);
  });

  it('returns null on an invalid range or when ATR cannot be computed', () => {
    expect(deriveAtrSpacing(flatCandles(30), 1100, 900)).toBeNull(); // lower >= upper
    expect(deriveAtrSpacing([{ high: 1, low: 1, close: 1 }], 900, 1100)).toBeNull(); // too few candles
  });
});
