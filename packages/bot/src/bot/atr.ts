// ATR-based grid spacing (#8). STATIC-AT-CREATION: compute ATR once from
// recent candles, derive a spacing %, and from it the number of grid levels
// for the user's [lower, upper] range. The grid is fixed-spacing thereafter —
// there is NO live re-gridding (that would be a separate, much riskier
// feature). Opt-in and configurable.
//
// The k multiplier and the spacing bands are the "Default" profile from the
// research. IMPORTANT (real money): k=0.6 rests on a single practitioner
// source and grid spacing wants k < 1 (so levels actually get crossed) — do
// NOT conflate it with the 1.5–3× ATR multiplier used for STOP-LOSS distance,
// which is the opposite objective. VALIDATE k against the realistic backtester
// over real GRVT data before trusting it in production. The fee floor below is
// the hard lower bound regardless of k.

import { minProfitableSpacing, makerFeeRate } from './fee-model.js';

/** Wilder (1978) default. ~two trading weeks. */
export const DEFAULT_ATR_PERIOD = 14;
/** 1h candles — matches the documented grid-ATR implementation. */
export const DEFAULT_ATR_INTERVAL = 'CI_1_H';
/** Grid wants k < 1 so price oscillations cross at least one level. */
export const DEFAULT_ATR_MULTIPLIER = 0.6;
/** Lower clamp (%) — the fee floor can raise it but never lower it. */
export const DEFAULT_ATR_MIN_SPACING_PCT = 1.0;
/** Upper clamp (%) — prevents too-few-trades in high volatility. */
export const DEFAULT_ATR_MAX_SPACING_PCT = 4.0;

export interface AtrCandle {
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder's ATR. Candles MUST be ascending (oldest→newest). Needs at least
 * period+1 candles (the first true range needs a previous close). Returns
 * null when there isn't enough data or a value is non-finite.
 *
 *   TR_t      = max(high−low, |high−prevClose|, |low−prevClose|)
 *   ATR_seed  = SMA(TR_1 … TR_period)              // Wilder's simple seed
 *   ATR_t     = (ATR_{t−1} × (period−1) + TR_t) / period   // Wilder smoothing
 */
export function computeATR(
  candles: AtrCandle[],
  period: number = DEFAULT_ATR_PERIOD
): number | null {
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 1) return null;
  if (candles.length < period + 1) return null;

  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    if (![c.high, c.low, c.close, prev.close].every(Number.isFinite)) return null;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  if (tr.length < period) return null;

  // Wilder seed: simple average of the first `period` true ranges.
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  // Wilder smoothing over the remaining true ranges.
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  return Number.isFinite(atr) ? atr : null;
}

export interface AtrSpacingParams {
  period?: number;
  /** k in spacing = k × ATR. */
  multiplier?: number;
  minSpacingPct?: number;
  maxSpacingPct?: number;
  /** Maker fee rate (decimal) for the fee floor. Defaults to the shared model. */
  feeRate?: number;
}

export interface AtrSpacingResult {
  atr: number;
  /** ATR as % of the range mid. */
  atrPct: number;
  /** k × atrPct, before clamping. */
  rawSpacingPct: number;
  /** Final spacing %, after clamp. */
  spacingPct: number;
  /** Final spacing in price units. */
  spacingAbs: number;
  /** Derived grid count for [lower, upper] using the engine formula. */
  numGrids: number;
  /** Effective lower clamp = max(minSpacingPct, fee floor %). */
  floorPct: number;
  clampedAtFloor: boolean;
  clampedAtCap: boolean;
}

/**
 * Derive grid spacing and num_grids from ATR for the range [lower, upper]:
 *
 *   spacingPct = clamp(k × ATR%, floor, cap)
 *   floor      = max(minSpacingPct, minProfitableSpacing(mid)/mid × 100)
 *   numGrids   = round((upper − lower) / spacingAbs)   // engine formula, ≥ 2
 *
 * The fee floor reuses minProfitableSpacing() (the single source of truth) so
 * an ATR-derived grid can never undercut round-trip-fee profitability, no
 * matter how low the volatility or how small k. Returns null when ATR can't
 * be computed or the range is invalid.
 */
export function deriveAtrSpacing(
  candles: AtrCandle[],
  lower: number,
  upper: number,
  params: AtrSpacingParams = {}
): AtrSpacingResult | null {
  const period = params.period ?? DEFAULT_ATR_PERIOD;
  const k = params.multiplier ?? DEFAULT_ATR_MULTIPLIER;
  const minPct = params.minSpacingPct ?? DEFAULT_ATR_MIN_SPACING_PCT;
  const maxPct = params.maxSpacingPct ?? DEFAULT_ATR_MAX_SPACING_PCT;
  const feeRate = params.feeRate ?? makerFeeRate();

  if (!(lower > 0) || !(upper > lower) || !(k > 0)) return null;

  const atr = computeATR(candles, period);
  if (atr === null || atr <= 0) return null;

  const mid = (upper + lower) / 2;
  const atrPct = (atr / mid) * 100;
  const rawSpacingPct = k * atrPct;

  const feeFloorPct = (minProfitableSpacing(mid, feeRate) / mid) * 100;
  const floorPct = Math.max(minPct, feeFloorPct);
  // Never let the cap fall below the floor (defensive against bad params).
  const cap = Math.max(maxPct, floorPct);

  let spacingPct = rawSpacingPct;
  let clampedAtFloor = false;
  let clampedAtCap = false;
  if (spacingPct < floorPct) {
    spacingPct = floorPct;
    clampedAtFloor = true;
  } else if (spacingPct > cap) {
    spacingPct = cap;
    clampedAtCap = true;
  }

  const spacingAbs = (spacingPct / 100) * mid;
  const numGrids = Math.max(2, Math.round((upper - lower) / spacingAbs));

  return {
    atr,
    atrPct,
    rawSpacingPct,
    spacingPct,
    spacingAbs,
    numGrids,
    floorPct,
    clampedAtFloor,
    clampedAtCap,
  };
}
