// D.5 — Range update plan tests.
// Pure-function tests of computeRangeUpdatePlan(). The function builds
// a RangeUpdatePlan from (bot, newLower, newUpper, currentPrice,
// currentPosition, existingLevels). The orchestrator (buildRangeUpdatePlan
// on the engine class) just fetches those inputs from GRVT/DB and
// delegates here, so this is where the safety logic lives.

import { describe, it, expect } from 'vitest';
import { computeRangeUpdatePlan, type RangeUpdateInputs } from '../src/bot/grid-engine';

function inputs(overrides: Partial<RangeUpdateInputs> = {}): RangeUpdateInputs {
  return {
    bot: {
      id: 1,
      pair: 'ETH_USDT_Perp',
      lower_price: 1800,
      upper_price: 2400,
      num_grids: 30,
      quantity_per_level: 0.05,
    },
    newLower: 1900,
    newUpper: 2300,
    currentPrice: 2100,
    currentPosition: 1.5,
    existingLevels: [],
    ...overrides,
  };
}

describe('computeRangeUpdatePlan (D.5)', () => {
  it('detects no-op when range is unchanged (≤1 cent tolerance)', () => {
    const p = computeRangeUpdatePlan(inputs({ newLower: 1800.005, newUpper: 2400 }));
    expect(p.noop).toBe(true);
    expect(p.warnings).toContain('Range unchanged — this is a no-op');
  });

  it('does NOT mark noop when one bound moves past the 1-cent tolerance', () => {
    const p = computeRangeUpdatePlan(inputs({ newLower: 1810, newUpper: 2400 }));
    expect(p.noop).toBe(false);
  });

  it('flags violation when current price is outside the new range', () => {
    const p = computeRangeUpdatePlan(inputs({ currentPrice: 2500 }));
    expect(p.safetyViolations.some((v) => v.includes('outside new range'))).toBe(true);
  });

  it('flags violation when newLower < 50% of current price', () => {
    // currentPrice=2100, newLower=900 → 900 < 0.5 * 2100 (1050)
    const p = computeRangeUpdatePlan(inputs({ newLower: 900, newUpper: 2300, currentPosition: 0 }));
    expect(p.safetyViolations.some((v) => v.includes('Lower price too far below market'))).toBe(true);
  });

  it('flags violation when newUpper > 200% of current price', () => {
    // currentPrice=2100, newUpper=4500 → 4500 > 2.0 * 2100 (4200)
    const p = computeRangeUpdatePlan(inputs({ newUpper: 4500 }));
    expect(p.safetyViolations.some((v) => v.includes('Upper price too far above market'))).toBe(true);
  });

  it('flags violation when bot has no quantity_per_level', () => {
    const p = computeRangeUpdatePlan(
      inputs({
        bot: { ...inputs().bot, quantity_per_level: undefined },
      })
    );
    expect(p.safetyViolations.some((v) => v.includes('quantity_per_level'))).toBe(true);
  });

  it('flags violation when ETH auto-buy deficit exceeds the 2.0 cap', () => {
    // sells = ~half of 30 grids × 0.05 = 0.75 ETH needed for half a range,
    // bump it: use big qty + big position deficit.
    const p = computeRangeUpdatePlan(
      inputs({
        bot: { ...inputs().bot, num_grids: 100, quantity_per_level: 0.1 },
        currentPosition: 0,
      })
    );
    // sellLevels ≈ 50, ethNeeded ≈ 5 ETH, deficit = 5 > 2.0 cap.
    expect(p.ethDeficit).toBeGreaterThan(2.0);
    expect(p.safetyViolations.some((v) => v.includes('exceeds safety cap'))).toBe(true);
  });

  it('emits an autoBuy plan with slippage when there is a deficit ≤ cap', () => {
    // Position = 0.3, ethNeeded ≈ 16 * 0.05 = 0.8 → deficit = 0.5 (< 2.0).
    const p = computeRangeUpdatePlan(inputs({ currentPosition: 0.3 }));
    expect(p.ethDeficit).toBeGreaterThan(0);
    expect(p.autoBuy).not.toBeNull();
    expect(p.autoBuy!.slippagePct).toBe(0.5);
    // estimatedPrice = ceil(2100 * 1.005 * 100) / 100 = 2110.5
    expect(p.autoBuy!.estimatedPrice).toBeCloseTo(2110.5, 2);
    expect(p.warnings.some((w) => w.includes('market-buy'))).toBe(true);
  });

  it('emits no autoBuy when current position covers the sell side', () => {
    // Big position vs small sell side → no deficit, only excess warning.
    const p = computeRangeUpdatePlan(inputs({ currentPosition: 5 }));
    expect(p.ethDeficit).toBe(0);
    expect(p.autoBuy).toBeNull();
    expect(p.ethExcess).toBeGreaterThan(0);
    expect(p.warnings.some((w) => w.includes('excess'))).toBe(true);
  });

  it('builds buy levels below currentPrice and sell levels at/above', () => {
    // currentPrice = 2100, range 1900-2300, 30 grids → spacing ~13.33.
    const p = computeRangeUpdatePlan(inputs());
    for (const lvl of p.newLevels) {
      if (lvl.side === 'buy') expect(lvl.price).toBeLessThan(2100);
      else expect(lvl.price).toBeGreaterThanOrEqual(2100);
    }
    expect(p.newSellLevels + p.newBuyLevels).toBe(p.newTotalLevels);
    expect(p.newTotalLevels).toBe(31); // 30 grids → 31 levels (0..30)
  });

  it('records orders to cancel from existing levels with real order_ids', () => {
    const p = computeRangeUpdatePlan(
      inputs({
        existingLevels: [
          { order_id: '0xabc', price: 2000 },
          { order_id: '0xdef', price: 2100 },
          { order_id: '0x00', price: 2200 },              // sentinel — skip
          { order_id: 'price_based_detection', price: 2300 }, // sentinel — skip
          { order_id: null, price: 2400 },                // empty — skip
        ],
      })
    );
    expect(p.ordersToCancel).toBe(2);
    expect(p.ordersToCancelSample).toEqual([
      { order_id: '0xabc', price: 2000 },
      { order_id: '0xdef', price: 2100 },
    ]);
  });

  it('records position-read failure as a safety violation', () => {
    const p = computeRangeUpdatePlan(inputs({ positionReadError: 'GRVT timeout' }));
    expect(p.safetyViolations.some((v) => v.includes('Cannot read live position'))).toBe(true);
    expect(p.safetyViolations.some((v) => v.includes('GRVT timeout'))).toBe(true);
  });

  it('returns the plan even when violations exist (caller decides whether to commit)', () => {
    const p = computeRangeUpdatePlan(
      inputs({
        bot: { ...inputs().bot, quantity_per_level: undefined },
        currentPrice: 9999,
      })
    );
    expect(p.safetyViolations.length).toBeGreaterThan(0);
    expect(p.newRange).toEqual({ lower: 1900, upper: 2300 });
    expect(p.newLevels.length).toBe(31);
  });
});
