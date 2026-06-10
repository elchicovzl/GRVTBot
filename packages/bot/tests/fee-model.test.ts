// F1.1 — Shared fee model tests.
// Pure math: round-trip fee cost and the minimum profitable spacing
// floor used by validateGridConfig + computeRangeUpdatePlan.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_RATE,
  MIN_SPACING_SAFETY_FACTOR,
  makerFeeRate,
  takerFeeRate,
  roundTripFeeUsdt,
  minProfitableSpacing,
} from '../src/bot/fee-model';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fee rate constants', () => {
  it('maker default is 5 bps per side (matches backtester feePct=0.05)', () => {
    expect(DEFAULT_MAKER_FEE_RATE).toBe(0.0005);
  });

  it('taker default is 10 bps per side', () => {
    expect(DEFAULT_TAKER_FEE_RATE).toBe(0.001);
  });

  it('makerFeeRate() honors GRVT_MAKER_FEE_RATE env override', () => {
    vi.stubEnv('GRVT_MAKER_FEE_RATE', '0.0003');
    expect(makerFeeRate()).toBe(0.0003);
  });

  it('takerFeeRate() honors GRVT_TAKER_FEE_RATE env override', () => {
    vi.stubEnv('GRVT_TAKER_FEE_RATE', '0.0007');
    expect(takerFeeRate()).toBe(0.0007);
  });

  it('falls back to default on garbage or out-of-range env values', () => {
    vi.stubEnv('GRVT_MAKER_FEE_RATE', 'not-a-number');
    expect(makerFeeRate()).toBe(DEFAULT_MAKER_FEE_RATE);

    vi.stubEnv('GRVT_MAKER_FEE_RATE', '-0.001');
    expect(makerFeeRate()).toBe(DEFAULT_MAKER_FEE_RATE);

    // 0.05 = 5% per side — clearly a bps/percent unit mistake
    vi.stubEnv('GRVT_MAKER_FEE_RATE', '0.05');
    expect(makerFeeRate()).toBe(DEFAULT_MAKER_FEE_RATE);
  });
});

describe('roundTripFeeUsdt', () => {
  it('charges both legs: (buy + sell) * qty * feeRate', () => {
    // buy 2000, sell 2010, qty 0.05, 5 bps
    // (2000 + 2010) * 0.05 * 0.0005 = 0.10025
    expect(roundTripFeeUsdt(2000, 2010, 0.05, 0.0005)).toBeCloseTo(0.10025, 6);
  });

  it('matches the backtester round-trip fee formula', () => {
    // backtester.ts: fee = (counterLevel.price + level.price) * qty * feeRate
    const buy = 1850.5;
    const sell = 1870.25;
    const qty = 0.04;
    const feeRate = 0.0005;
    expect(roundTripFeeUsdt(buy, sell, qty, feeRate)).toBeCloseTo(
      (buy + sell) * qty * feeRate,
      10
    );
  });

  it('defaults to the maker rate when feeRate is omitted', () => {
    expect(roundTripFeeUsdt(2000, 2000, 1)).toBeCloseTo(
      4000 * DEFAULT_MAKER_FEE_RATE,
      10
    );
  });

  it('is zero for zero qty', () => {
    expect(roundTripFeeUsdt(2000, 2010, 0, 0.0005)).toBe(0);
  });
});

describe('minProfitableSpacing', () => {
  it('equals 2 * mid * feeRate * safetyFactor', () => {
    // mid 2100, 5 bps, 1.5x → 2 * 2100 * 0.0005 * 1.5 = 3.15
    expect(minProfitableSpacing(2100, 0.0005, 1.5)).toBeCloseTo(3.15, 6);
  });

  it('uses the maker rate and 1.5x safety by default', () => {
    expect(minProfitableSpacing(2100)).toBeCloseTo(
      2 * 2100 * DEFAULT_MAKER_FEE_RATE * MIN_SPACING_SAFETY_FACTOR,
      10
    );
  });

  it('is independent of qty: spacing*qty > roundTripFee*safety at the floor', () => {
    const mid = 2100;
    const floor = minProfitableSpacing(mid, 0.0005, 1.5);
    for (const qty of [0.01, 0.05, 1, 10]) {
      const profit = (floor + 0.01) * qty; // just above the floor
      const fee = roundTripFeeUsdt(mid, mid + floor, qty, 0.0005);
      expect(profit).toBeGreaterThan(fee * 1.5 * 0.99); // ~holds (mid approximation)
    }
  });

  it('scales linearly with price and fee rate', () => {
    expect(minProfitableSpacing(4200, 0.0005, 1.5)).toBeCloseTo(
      2 * minProfitableSpacing(2100, 0.0005, 1.5),
      10
    );
    expect(minProfitableSpacing(2100, 0.001, 1.5)).toBeCloseTo(
      2 * minProfitableSpacing(2100, 0.0005, 1.5),
      10
    );
  });
});
