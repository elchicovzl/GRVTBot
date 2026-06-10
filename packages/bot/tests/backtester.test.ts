// H.6 — Backtester unit tests.
// Pure-function tests: feed synthetic candles, assert stats. No GRVT,
// no DB. getInstrumentSpec falls back to a sane default when the pair
// isn't in the cache, so no mocking is needed.
//
// F3.3: the sim now charges funding, taker fee + slippage on the
// initial purchase, and enforces the active order window. Legacy-style
// tests use NEUTRAL overrides to isolate the grid mechanics.

import { describe, it, expect } from 'vitest';
import { runBacktest, type BacktestCandle } from '../src/bot/backtester';
import { roundTripFeeUsdt } from '../src/bot/fee-model';

const BASE = {
  pair: 'TEST_USDT_Perp',
  direction: 'long' as const,
  leverage: 1,
  lowerPrice: 100,
  upperPrice: 110,
  numGrids: 10,
  investmentUSDT: 1000,
};

// Disable every realism cost so tests can isolate one knob at a time.
const NEUTRAL = {
  takerFeePct: 0,
  slippageBps: 0,
  fundingRatePer8h: 0,
  simulateInitialPurchase: false,
};

// qty per level for BASE: effCap = 1000 * 1 * 0.75 = 750;
// ceil(750 / 10 / 105 * 100) / 100 = 0.72 (> min_size fallback 0.01).
const QTY = 0.72;

// Build a candle that sweeps from `low` to `high` so every grid level
// inside the range is touched. One candle per second from t=0.
function sweepCandle(low: number, high: number, time: number): BacktestCandle {
  return { time, open: low, close: high, low, high };
}

// Anchor candle at a fixed price — used as the first candle so the
// engine's level-side assignment (buys below mid, sells above) lines up
// with what the test wants. `close` here = `firstPrice` in runBacktest.
function anchor(price: number, time: number): BacktestCandle {
  return { time, open: price, close: price, low: price, high: price };
}

describe('runBacktest', () => {
  it('returns zero result on empty candles', () => {
    const r = runBacktest(BASE, []);
    expect(r.candlesProcessed).toBe(0);
    expect(r.roundTrips).toBe(0);
    expect(r.totalProfit).toBe(0);
    expect(r.netProfit).toBe(0);
    expect(r.fundingUsdt).toBe(0);
    expect(r.slippageUsdt).toBe(0);
    expect(r.missedFillsWindow).toBe(0);
    expect(r.equityCurve).toEqual([]);
  });

  it('records round trips when price oscillates through the range', () => {
    // Anchor at mid (105) so levels split into 5 buys (100-104) and
    // 6 sells (105-110). Each upward sweep fills sells, each downward
    // sweep refills the matching buys → round trips.
    const candles: BacktestCandle[] = [
      anchor(105, 0),
      sweepCandle(99, 111, 3600),
      sweepCandle(99, 111, 7200),
    ];
    const r = runBacktest({ ...BASE, ...NEUTRAL }, candles);
    expect(r.candlesProcessed).toBe(3);
    expect(r.roundTrips).toBeGreaterThan(0);
    expect(r.totalProfit).toBeGreaterThan(0);
    expect(r.equityCurve).toHaveLength(3);
  });

  it('charges fees on every round trip and reduces netProfit accordingly', () => {
    const candles: BacktestCandle[] = [
      anchor(105, 0),
      sweepCandle(99, 111, 3600),
    ];
    const noFee = runBacktest({ ...BASE, ...NEUTRAL, feePct: 0 }, candles);
    const withFee = runBacktest({ ...BASE, ...NEUTRAL, feePct: 0.05 }, candles);

    expect(noFee.roundTrips).toBeGreaterThan(0);
    expect(noFee.totalFees).toBe(0);
    expect(withFee.totalFees).toBeGreaterThan(0);
    expect(withFee.netProfit).toBeLessThan(noFee.netProfit);
    // Same gross profit either way — fees only affect net.
    expect(withFee.totalProfit).toBeCloseTo(noFee.totalProfit, 2);
  });

  it('defaults the maker rate to fee-model.ts (single round trip)', () => {
    // Anchor at 105 → sell level 105 fills against counter buy 104:
    // exactly one round trip, fee = roundTripFeeUsdt(104, 105, qty).
    const r = runBacktest({ ...BASE, ...NEUTRAL }, [anchor(105, 0)]);
    expect(r.roundTrips).toBe(1);
    expect(r.totalFees).toBeCloseTo(roundTripFeeUsdt(104, 105, QTY), 2);
  });

  it('tracks max drawdown when price falls below the range', () => {
    // Anchor at mid → buys at 100-104. Sweep upward fills nothing on
    // buys but does fill sells (no position yet — short sells aren't
    // modeled, this is a long grid). Then a crash candle creates
    // mark-to-market drawdown on whatever long position was opened.
    const candles: BacktestCandle[] = [
      anchor(105, 0),
      { time: 3600, open: 105, high: 105, low: 99, close: 99 },  // hits all buys
      { time: 7200, open: 99, high: 99, low: 50, close: 50 },    // crash
    ];
    const r = runBacktest({ ...BASE, ...NEUTRAL }, candles);
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('reports daysInMarket from first to last candle time', () => {
    const oneDay = 86400;
    const candles: BacktestCandle[] = [
      anchor(105, 0),
      anchor(105, oneDay * 7),
    ];
    const r = runBacktest({ ...BASE, ...NEUTRAL }, candles);
    expect(r.daysInMarket).toBe(7);
  });
});

describe('runBacktest — funding', () => {
  // Dip candle fills buys 100-104 and re-arms+fills sell 105 → 4 * QTY.
  // The third candle (t=28800) re-fills buy 104 → 5 * QTY = 3.6 held
  // when the 8h boundary is crossed, marked at close 99 →
  // funding = 3.6 * 99 * rate. Longs PAY positive rates.
  const candles: BacktestCandle[] = [
    anchor(105, 0),
    { time: 3600, open: 105, high: 105, low: 99, close: 99 },
    anchor(99, 28800),
  ];

  it('with vs without constant funding differs by exactly the funding paid', () => {
    const rate = 0.001; // exaggerated for visibility
    const noFunding = runBacktest({ ...BASE, ...NEUTRAL }, candles);
    const withFunding = runBacktest(
      { ...BASE, ...NEUTRAL, fundingRatePer8h: rate },
      candles
    );

    const expected = 5 * QTY * 99 * rate; // 0.3564
    expect(noFunding.fundingUsdt).toBe(0);
    expect(withFunding.fundingUsdt).toBeCloseTo(expected, 4);
    expect(noFunding.netProfit - withFunding.netProfit).toBeCloseTo(expected, 1);
  });

  it('applies the default funding rate when none is given', () => {
    const r = runBacktest(
      { ...BASE, ...NEUTRAL, fundingRatePer8h: undefined },
      candles
    );
    // DEFAULT_FUNDING_RATE_PER_8H = 0.0001 → 3.6 * 99 * 0.0001
    expect(r.fundingUsdt).toBeCloseTo(5 * QTY * 99 * 0.0001, 4);
  });

  it('uses a historical fundingRates series when provided (overrides constant)', () => {
    const r = runBacktest(
      {
        ...BASE, ...NEUTRAL,
        fundingRatePer8h: 0.005, // must be ignored
        fundingRates: [
          { time: 3600, rate: 0.002 },   // applied at the dip candle, close 99
          { time: 999999, rate: 0.002 }, // beyond last candle → never applied
        ],
      },
      candles
    );
    // Position at t=3600 AFTER fills: +5 buys, -1 sell (105 re-arms and
    // closes one slot within the same candle) → 4 * QTY.
    expect(r.fundingUsdt).toBeCloseTo(4 * QTY * 99 * 0.002, 4);
  });

  it('no position → no funding', () => {
    // Anchor above the range: every level is a buy, price never dips.
    const r = runBacktest(
      { ...BASE, ...NEUTRAL, fundingRatePer8h: 0.001 },
      [anchor(111, 0), anchor(111, 86400)]
    );
    expect(r.fundingUsdt).toBe(0);
  });
});

describe('runBacktest — slippage and taker fees (initial purchase)', () => {
  // Anchor at 105 → 6 sell levels (105-110) → initial IOC buys
  // 6 * QTY = 4.32 at 105. Slippage and taker fee hit that leg only.
  const candles: BacktestCandle[] = [anchor(105, 0), sweepCandle(99, 111, 3600)];

  it('applies slippage ONLY to the taker leg, never to resting maker fills', () => {
    const common = {
      ...BASE, feePct: 0, takerFeePct: 0, fundingRatePer8h: 0,
      simulateInitialPurchase: true,
    };
    const noSlip = runBacktest({ ...common, slippageBps: 0 }, candles);
    const withSlip = runBacktest({ ...common, slippageBps: 10 }, candles);

    const expected = 105 * 6 * QTY * 0.001; // 0.4536
    expect(noSlip.slippageUsdt).toBe(0);
    expect(withSlip.slippageUsdt).toBeCloseTo(expected, 4);
    expect(noSlip.netProfit - withSlip.netProfit).toBeCloseTo(expected, 1);
    // Maker legs unaffected: identical gross profit and round trips.
    expect(withSlip.totalProfit).toBeCloseTo(noSlip.totalProfit, 2);
    expect(withSlip.roundTrips).toBe(noSlip.roundTrips);
  });

  it('no taker execution → slippage has zero effect', () => {
    const common = {
      ...BASE, feePct: 0, takerFeePct: 0, fundingRatePer8h: 0,
      simulateInitialPurchase: false,
    };
    const a = runBacktest({ ...common, slippageBps: 0 }, candles);
    const b = runBacktest({ ...common, slippageBps: 50 }, candles);
    expect(b.slippageUsdt).toBe(0);
    expect(b.netProfit).toBe(a.netProfit);
  });

  it('charges the taker fee on the initial purchase notional', () => {
    const r = runBacktest(
      {
        ...BASE, feePct: 0, takerFeePct: 0.1, slippageBps: 0,
        fundingRatePer8h: 0, simulateInitialPurchase: true,
      },
      [anchor(105, 0)]
    );
    // 105 * 4.32 * 0.001 = 0.4536 → rounded 0.45
    expect(r.totalFees).toBeCloseTo(105 * 6 * QTY * 0.001, 2);
  });
});

describe('runBacktest — active order window (80-order cap)', () => {
  // Anchor at 111 → all 11 levels are buys. A gap candle from 111 to 99
  // crosses the whole grid in one step. With a 5-level window, only the
  // 5 closest levels (106-110) had resting orders — 100-105 are missed.
  const candles: BacktestCandle[] = [
    anchor(111, 0),
    { time: 3600, open: 111, high: 111, low: 99, close: 99 },
  ];

  it('a gap candle does not fill levels outside the window and reports them', () => {
    const capped = runBacktest(
      { ...BASE, ...NEUTRAL, activeWindowSize: 5 },
      candles
    );
    const uncapped = runBacktest(
      { ...BASE, ...NEUTRAL, activeWindowSize: 80 },
      candles
    );

    expect(capped.missedFillsWindow).toBe(6);   // buys 100-105 skipped
    expect(uncapped.missedFillsWindow).toBe(0); // everything fits

    // Capped bot bought 5 levels into the drop, uncapped bought 11 →
    // uncapped carries a much larger mark-to-market loss at close 99.
    const cappedFinal = capped.equityCurve.at(-1)!.equity;
    const uncappedFinal = uncapped.equityCurve.at(-1)!.equity;
    expect(cappedFinal).toBeGreaterThan(uncappedFinal);
  });

  it('window re-centers next candle so missed levels can fill on a retouch', () => {
    const r = runBacktest(
      { ...BASE, ...NEUTRAL, activeWindowSize: 5 },
      [
        ...candles,
        anchor(99, 7200), // window now centered at 99 → 100-104 fill
        anchor(99, 10800),
      ]
    );
    // The retouch fills the 5 closest of the 6 previously-missed buys
    // (100-104); 105 is outside the recentered window → one more miss.
    expect(r.missedFillsWindow).toBe(7);
    const last = r.equityCurve.at(-1)!.equity;
    const afterGap = r.equityCurve[1]!.equity;
    // More inventory bought at 99-ish marks flat at 99 → equity dropped
    // further only via the extra buys' MTM (they fill AT level price
    // above the 99 close), so equity strictly decreases vs the gap candle.
    expect(last).toBeLessThan(afterGap);
  });

  it('default window (70) never blocks fills for grids under the cap', () => {
    const r = runBacktest({ ...BASE, ...NEUTRAL }, candles);
    expect(r.missedFillsWindow).toBe(0);
  });
});

describe('runBacktest — baseline regression', () => {
  // ── BASELINE (F3.3) ──
  // Fixed synthetic series with ALL realism defaults active: maker
  // 5 bps, taker 10 bps on the initial purchase, 2 bps slippage,
  // 0.01%/8h funding, 70-level window, initial purchase simulated.
  // These exact numbers document the simulator's behavior — if you
  // change the sim, you must CONSCIOUSLY update them and explain why
  // in the commit message.
  it('produces the exact documented net result', () => {
    const candles: BacktestCandle[] = [
      anchor(105, 0),
      sweepCandle(99, 111, 3600),
      sweepCandle(101, 109, 7200),
      { time: 28800, open: 109, high: 109, low: 104, close: 104 },
      { time: 57600, open: 104, high: 104, low: 100, close: 100 },
    ];
    const r = runBacktest(BASE, candles);

    expect(r).toMatchObject({
      candlesProcessed: 5,
      roundTrips: 16,
      missedFillsWindow: 0,
      totalProfit: 11.52,
      totalFees: 1.68,
      fundingUsdt: 0.0072,
      slippageUsdt: 0.0907,
      netProfit: 9.74,
      maxDrawdownPct: 1.82,
      daysInMarket: 1,
    });
  });
});
