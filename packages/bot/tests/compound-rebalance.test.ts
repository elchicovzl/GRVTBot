// D.4 — Compound rebalance decision tests.
// Pure-function tests of decideCompound(), the rule that drives the
// hourly checkCompoundRebalance() loop in grid-engine.ts. Charges real
// money in production — the rules need explicit coverage:
//   - off when compound_pct = 0
//   - interval lock vs last_compound_at
//   - threshold trigger uses (grid_profit - already_compounded)
//   - new investment + qty_per_level recompute matches the formula

import { describe, it, expect } from 'vitest';
import { decideCompound, computeQtyPerLevel } from '../src/bot/grid-engine';
import type { GridBot } from '../src/database/db';

// Minimal bot fixture. Only the fields decideCompound actually reads.
function bot(overrides: Partial<GridBot> = {}): GridBot {
  return {
    id: 1,
    pair: 'ETH_USDT_Perp',
    direction: 'long',
    leverage: 5,
    lower_price: 1800,
    upper_price: 2400,
    num_grids: 30,
    investment_usdt: 1000,
    grid_profit_usdt: 0,
    trend_pnl_usdt: 0,
    total_pnl_usdt: 0,
    status: 'running',
    position_size: 0,
    avg_entry_price: 0,
    liquidation_price: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    params_json: '{}',
    compound_pct: 50,
    compound_threshold_usdt: 50,
    compound_interval_hours: 24,
    ...overrides,
  } as GridBot;
}

const NOW = new Date('2026-05-03T12:00:00Z');

describe('decideCompound (D.4)', () => {
  it('returns "disabled" when compound_pct is 0 (default off)', () => {
    const d = decideCompound(bot({ compound_pct: 0, grid_profit_usdt: 1000 }), 0, NOW);
    expect(d).toEqual({ compound: false, reason: 'disabled' });
  });

  it('returns "disabled" when compound_pct is missing', () => {
    const d = decideCompound(bot({ compound_pct: undefined, grid_profit_usdt: 1000 }), 0, NOW);
    expect(d.compound).toBe(false);
    if (!d.compound) expect(d.reason).toBe('disabled');
  });

  it('returns "interval_lock" when last_compound_at is within compound_interval_hours', () => {
    // Compounded 6h ago, interval is 24h → still locked.
    const lastCompoundAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const d = decideCompound(
      bot({
        compound_pct: 50,
        compound_interval_hours: 24,
        last_compound_at: lastCompoundAt,
        grid_profit_usdt: 1000,
      }),
      0,
      NOW
    );
    expect(d.compound).toBe(false);
    if (!d.compound && d.reason === 'interval_lock') {
      expect(d.hoursSince).toBeCloseTo(6, 1);
      expect(d.intervalHours).toBe(24);
    } else {
      throw new Error(`expected interval_lock, got ${JSON.stringify(d)}`);
    }
  });

  it('proceeds when last_compound_at is older than the interval', () => {
    // Compounded 25h ago, interval is 24h → unlocked.
    const lastCompoundAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const d = decideCompound(
      bot({
        compound_pct: 50,
        compound_interval_hours: 24,
        last_compound_at: lastCompoundAt,
        grid_profit_usdt: 200,
        compound_threshold_usdt: 50,
      }),
      0,
      NOW
    );
    expect(d.compound).toBe(true);
  });

  it('returns "below_threshold" when available profit is under threshold', () => {
    const d = decideCompound(
      bot({ grid_profit_usdt: 30, compound_threshold_usdt: 50 }),
      0,
      NOW
    );
    expect(d.compound).toBe(false);
    if (!d.compound && d.reason === 'below_threshold') {
      expect(d.availableProfit).toBe(30);
      expect(d.threshold).toBe(50);
    } else {
      throw new Error(`expected below_threshold, got ${JSON.stringify(d)}`);
    }
  });

  it('subtracts alreadyCompounded from grid_profit before threshold check', () => {
    // grid_profit_usdt = 200, alreadyCompounded = 180 → available = 20 < 50.
    // Without the subtraction this would compound — verifies we don't
    // compound the same dollar twice.
    const d = decideCompound(
      bot({ grid_profit_usdt: 200, compound_threshold_usdt: 50 }),
      180,
      NOW
    );
    expect(d.compound).toBe(false);
    if (!d.compound && d.reason === 'below_threshold') {
      expect(d.availableProfit).toBe(20);
    }
  });

  it('computes compoundAmount as availableProfit * (pct / 100)', () => {
    const d = decideCompound(
      bot({
        grid_profit_usdt: 300,
        compound_pct: 40,
        compound_threshold_usdt: 50,
        investment_usdt: 1000,
      }),
      0,
      NOW
    );
    expect(d.compound).toBe(true);
    if (d.compound) {
      // 40% of $300 = $120
      expect(d.compoundAmount).toBe(120);
      expect(d.newInvestment).toBe(1120);
    }
  });

  it('newQty matches the standalone computeQtyPerLevel formula', () => {
    const b = bot({
      pair: 'ETH_USDT_Perp',
      grid_profit_usdt: 200,
      compound_pct: 50,
      compound_threshold_usdt: 50,
      investment_usdt: 1000,
      leverage: 5,
      num_grids: 30,
      lower_price: 1800,
      upper_price: 2400,
    });
    const d = decideCompound(b, 0, NOW);
    expect(d.compound).toBe(true);
    if (d.compound) {
      const expectedQty = computeQtyPerLevel(d.newInvestment, b.leverage, b.num_grids, (b.lower_price + b.upper_price) / 2, b.pair);
      expect(d.newQty).toBe(expectedQty);
    }
  });

  it('uses default threshold (50) and interval (24h) when fields are missing', () => {
    // No threshold/interval set → defaults applied.
    const d = decideCompound(
      bot({
        grid_profit_usdt: 60,
        compound_pct: 50,
        compound_threshold_usdt: undefined,
        compound_interval_hours: undefined,
        last_compound_at: undefined,
      }),
      0,
      NOW
    );
    // 60 > default threshold 50 → compound.
    expect(d.compound).toBe(true);
  });
});
