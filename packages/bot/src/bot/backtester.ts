// H.6 — Grid backtesting engine.
// Pure simulation: takes a grid config + historical candles, walks
// each candle to detect level fills, computes profit/drawdown/equity.
// No real GRVT calls, no DB writes, no Date.now — entirely deterministic.
//
// F3.3 realism upgrades (these are what made live results undershoot
// the old backtests):
//   1. Funding: perps pay/receive funding every 8h on the open position.
//      Callers can pass a historical `fundingRates` series; when absent a
//      constant `fundingRatePer8h` (default 0.01% = the typical perp
//      baseline) is applied at every 8h epoch boundary.
//   2. Fees from fee-model.ts: maker rate for resting grid fills, taker
//      rate for the simulated initial position purchase (the live engine
//      opens longs with an IOC buy — see executeInitialPurchase).
//   3. Slippage: `slippageBps` (default 2 bps) applied ONLY to
//      taker-style executions (the initial purchase). Resting maker
//      fills keep the exact level price — that part is realistic.
//   4. 80-order cap / virtual window: only the `activeWindowSize`
//      closest levels (default 70, mirroring grid-engine.ts H.8) have
//      resting orders. A candle that gaps beyond the window does NOT
//      fill those levels; they're counted in `missedFillsWindow`. The
//      window re-centers on the previous candle's close each candle
//      (approximation of rotateVirtualWindow).

import { getInstrumentSpec } from '../api/client.js';
import { makerFeeRate, takerFeeRate } from './fee-model.js';

/**
 * Default funding rate per 8h interval (decimal). 0.01% per 8h is the
 * standard perp baseline (≈ 10.95% annualized) used by GRVT and most
 * venues when markets are balanced. Longs PAY positive funding.
 */
export const DEFAULT_FUNDING_RATE_PER_8H = 0.0001;

/** Funding interval in seconds (8 hours, epoch-aligned like GRVT). */
export const FUNDING_INTERVAL_SEC = 8 * 3600;

/** Default slippage on taker-style executions: 2 bps. */
export const DEFAULT_SLIPPAGE_BPS = 2;

/** Default virtual active window — mirrors grid-engine.ts H.8 (GRVT caps 80 open orders). */
export const DEFAULT_ACTIVE_WINDOW_SIZE = 70;

export interface FundingRatePoint {
  /** Unix seconds of the funding event. */
  time: number;
  /** Funding rate for that interval as a decimal (e.g. 0.0001 = 0.01%). Longs pay positive. */
  rate: number;
}

export interface BacktestConfig {
  pair: string;
  direction: 'long' | 'short';
  leverage: number;
  lowerPrice: number;
  upperPrice: number;
  numGrids: number;
  investmentUSDT: number;
  // Per-side MAKER fee in percent. 0.05 means 5 bps. Charged on both
  // legs of a round trip. Defaults to fee-model makerFeeRate().
  feePct?: number;
  // Per-side TAKER fee in percent for the initial purchase.
  // Defaults to fee-model takerFeeRate() (10 bps).
  takerFeePct?: number;
  // Slippage in basis points applied ONLY to taker executions
  // (initial purchase). Default 2 bps. Resting maker fills are exact.
  slippageBps?: number;
  // Constant funding rate per 8h interval (decimal). Default 0.0001.
  // Ignored when `fundingRates` is provided. Set 0 to disable funding.
  fundingRatePer8h?: number;
  // Historical funding series (preferred when the caller has it).
  // Each point is applied once when candle time reaches point.time.
  // NOTE: GRVT's public API exposes no historical funding-rate
  // endpoint today, so the v2-router endpoint uses the constant.
  fundingRates?: FundingRatePoint[];
  // Virtual active window: only the N closest unfilled levels have
  // resting orders (GRVT 80 open-order cap). Default 70.
  activeWindowSize?: number;
  // Simulate the engine's initial IOC purchase that backs the sell
  // levels of a LONG grid (taker fee + slippage). Default true.
  // Short grids skip it (the live engine's short path differs).
  simulateInitialPurchase?: boolean;
}

export interface BacktestCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestResult {
  totalProfit: number;
  /** Maker fees on round trips + taker fee on the initial purchase. */
  totalFees: number;
  /** Net funding PAID (negative = net received). */
  fundingUsdt: number;
  /** Slippage cost on taker executions. */
  slippageUsdt: number;
  /** Fills skipped because the level was outside the active order window. */
  missedFillsWindow: number;
  /** Realized: grossProfit - grossLoss - totalFees - fundingUsdt - slippageUsdt. */
  netProfit: number;
  maxDrawdownPct: number;
  roundTrips: number;
  avgProfitPerTrip: number;
  equityCurve: Array<{ time: number; equity: number }>;
  daysInMarket: number;
  profitFactor: number;
  candlesProcessed: number;
}

interface SimLevel {
  index: number;
  price: number;
  side: 'buy' | 'sell';
  quantity: number;
  isFilled: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export function runBacktest(
  config: BacktestConfig,
  candles: BacktestCandle[]
): BacktestResult {
  if (candles.length === 0) {
    return {
      totalProfit: 0, totalFees: 0, fundingUsdt: 0, slippageUsdt: 0,
      missedFillsWindow: 0, netProfit: 0,
      maxDrawdownPct: 0, roundTrips: 0,
      avgProfitPerTrip: 0, equityCurve: [], daysInMarket: 0,
      profitFactor: 0, candlesProcessed: 0,
    };
  }

  const { min_size: minSize } = getInstrumentSpec(config.pair);
  const spacing = (config.upperPrice - config.lowerPrice) / config.numGrids;
  const midPrice = (config.lowerPrice + config.upperPrice) / 2;
  const effCap = config.investmentUSDT * config.leverage * 0.75;
  const qty = Math.max(
    Math.ceil((effCap / config.numGrids / midPrice) * 100) / 100,
    minSize
  );

  // Fee model: maker for resting grid legs, taker for the initial IOC.
  const makerRate = config.feePct != null ? config.feePct / 100 : makerFeeRate();
  const takerRate = config.takerFeePct != null ? config.takerFeePct / 100 : takerFeeRate();
  const slippageRate = (config.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10000;
  const constFundingRate = config.fundingRatePer8h ?? DEFAULT_FUNDING_RATE_PER_8H;
  const fundingSeries = config.fundingRates;
  const windowSize = config.activeWindowSize ?? DEFAULT_ACTIVE_WINDOW_SIZE;
  // Longs pay positive funding, shorts receive it.
  const fundingSign = config.direction === 'long' ? 1 : -1;

  // Initialize grid levels
  const levels: SimLevel[] = [];
  const firstPrice = candles[0]!.close;
  for (let i = 0; i <= config.numGrids; i++) {
    const price = Math.round((config.lowerPrice + i * spacing) * 100) / 100;
    const side: 'buy' | 'sell' =
      config.direction === 'long'
        ? price < firstPrice ? 'buy' : 'sell'
        : price > firstPrice ? 'sell' : 'buy';
    levels.push({ index: i, price, side, quantity: qty, isFilled: false });
  }

  let equity = config.investmentUSDT;
  let hwm = equity;
  let maxDrawdownPct = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalFees = 0;
  let fundingPaid = 0;
  let slippageCost = 0;
  let missedFillsWindow = 0;
  let roundTrips = 0;
  let positionSize = 0;
  let positionCost = 0;
  const equityCurve: Array<{ time: number; equity: number }> = [];

  // Initial purchase (LONG only): the live engine market-buys (IOC) the
  // inventory backing every sell level before placing the grid — a
  // taker execution with slippage. Cost basis stays at firstPrice;
  // slippage and the taker fee are charged explicitly so netProfit and
  // the equity curve both see them exactly once.
  if ((config.simulateInitialPurchase ?? true) && config.direction === 'long') {
    const sellCount = levels.filter((l) => l.side === 'sell').length;
    if (sellCount > 0) {
      const initQty = qty * sellCount;
      const slipNotional = firstPrice * (1 + slippageRate) * initQty;
      const slip = firstPrice * slippageRate * initQty;
      const fee = slipNotional * takerRate;
      slippageCost += slip;
      totalFees += fee;
      equity -= slip + fee;
      positionSize += initQty;
      positionCost += firstPrice * initQty;
    }
  }

  const firstTime = candles[0]!.time;
  // Constant-rate funding: applied at every 8h epoch boundary STRICTLY
  // after the first candle (the position opens at the first candle).
  let nextFundingTime =
    Math.floor(firstTime / FUNDING_INTERVAL_SEC) * FUNDING_INTERVAL_SEC + FUNDING_INTERVAL_SEC;
  // Series funding: pointer past any points at/before the first candle.
  let fundingIdx = 0;
  if (fundingSeries) {
    while (fundingIdx < fundingSeries.length && fundingSeries[fundingIdx]!.time <= firstTime) {
      fundingIdx++;
    }
  }

  let prevClose = candles[0]!.open;

  // Walk candles
  for (const candle of candles) {
    // ── Active window (GRVT 80-order cap, H.8 virtual grids) ──
    // Orders resting during this candle are the `windowSize` unfilled
    // levels closest to where price WAS (previous close). Levels are
    // evenly spaced, so the closest-N set is a contiguous price band —
    // track its bounds so counter-levels re-armed mid-candle (always
    // adjacent to a fill, hence inside the band) are handled correctly.
    let windowLow = -Infinity;
    let windowHigh = Infinity;
    const unfilled = levels.filter((l) => !l.isFilled);
    if (unfilled.length > windowSize) {
      const closest = [...unfilled]
        .sort((a, b) => Math.abs(a.price - prevClose) - Math.abs(b.price - prevClose))
        .slice(0, windowSize);
      windowLow = Math.min(...closest.map((l) => l.price));
      windowHigh = Math.max(...closest.map((l) => l.price));
    }

    // Check each level for fills within this candle's range
    for (const level of levels) {
      if (level.isFilled) continue;

      const hit =
        level.side === 'buy'
          ? candle.low <= level.price
          : candle.high >= level.price;

      if (!hit) continue;

      // Touched, but no resting order there → missed fill, not a trade.
      // Next candle the window re-centers on this candle's close, so
      // the level can fill on a later retouch (rotateVirtualWindow).
      if (level.price < windowLow || level.price > windowHigh) {
        missedFillsWindow++;
        continue;
      }

      // Fill! Resting maker order → exact level price, maker fee.
      level.isFilled = true;

      if (level.side === 'buy') {
        positionSize += level.quantity;
        positionCost += level.price * level.quantity;
      } else {
        // Sell: realize profit from grid spread
        // Find the corresponding buy level (closest lower price)
        const counterIdx = level.index - 1;
        if (counterIdx >= 0 && counterIdx < levels.length) {
          const counterLevel = levels[counterIdx]!;
          const gross = (level.price - counterLevel.price) * level.quantity;
          // Maker fee charged on both legs of the round trip.
          const fee = (counterLevel.price + level.price) * level.quantity * makerRate;
          const profit = gross - fee;
          if (gross > 0) grossProfit += gross;
          else grossLoss += Math.abs(gross);
          totalFees += fee;
          roundTrips++;
          equity += profit;
        }
        positionSize = Math.max(0, positionSize - level.quantity);
        positionCost = positionSize > 0
          ? positionCost * (positionSize / (positionSize + level.quantity))
          : 0;
      }

      // Reset the counter level so it can trade again (grid cycling)
      const counterIdx = level.side === 'buy' ? level.index + 1 : level.index - 1;
      if (counterIdx >= 0 && counterIdx < levels.length) {
        levels[counterIdx]!.isFilled = false;
      }
    }

    // ── Funding on the open position ──
    // Mark notional approximated at the candle close (deterministic).
    if (fundingSeries) {
      while (fundingIdx < fundingSeries.length && fundingSeries[fundingIdx]!.time <= candle.time) {
        const payment = fundingSign * positionSize * candle.close * fundingSeries[fundingIdx]!.rate;
        fundingPaid += payment;
        equity -= payment;
        fundingIdx++;
      }
    } else if (constFundingRate !== 0) {
      while (candle.time >= nextFundingTime) {
        const payment = fundingSign * positionSize * candle.close * constFundingRate;
        fundingPaid += payment;
        equity -= payment;
        nextFundingTime += FUNDING_INTERVAL_SEC;
      }
    }

    // Unrealized PnL
    const unrealized = positionSize * (candle.close - (positionCost / Math.max(positionSize, 0.0001)));
    const currentEquity = equity + unrealized;

    if (currentEquity > hwm) hwm = currentEquity;
    const dd = hwm > 0 ? ((hwm - currentEquity) / hwm) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    equityCurve.push({ time: candle.time, equity: currentEquity });
    prevClose = candle.close;
  }

  const lastTime = candles[candles.length - 1]!.time;
  const daysInMarket = Math.max(1, (lastTime - firstTime) / 86400);

  // Net of EVERYTHING realized: maker+taker fees, funding, slippage.
  const netProfit = grossProfit - grossLoss - totalFees - fundingPaid - slippageCost;
  return {
    totalProfit: round2(grossProfit),
    totalFees: round2(totalFees),
    fundingUsdt: round4(fundingPaid),
    slippageUsdt: round4(slippageCost),
    missedFillsWindow,
    netProfit: round2(netProfit),
    maxDrawdownPct: round2(maxDrawdownPct),
    roundTrips,
    avgProfitPerTrip: roundTrips > 0 ? round2(netProfit / roundTrips) : 0,
    equityCurve,
    daysInMarket: Math.round(daysInMarket),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
    candlesProcessed: candles.length,
  };
}
