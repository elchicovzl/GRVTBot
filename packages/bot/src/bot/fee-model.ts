// Shared GRVT fee model.
//
// Single source of truth for fee assumptions across the engine, the
// API validation layer, and the backtester (backtester.ts already
// defaults feePct to 0.05 = 5 bps maker per side — these constants
// mirror that so the two never disagree).
//
// IMPORTANT: real fees charged by GRVT depend on the user's volume
// tier and can even be maker REBATES (fills_archive.fee is signed and
// negative values show up in production). These rates are the
// conservative DEFAULT assumption used for pre-trade validation and
// estimates — actual realized fees always come from fills_archive.

/** GRVT maker fee per side: 5 bps (0.05%). Matches backtester.ts feePct default. */
export const DEFAULT_MAKER_FEE_RATE = 0.0005;

/** GRVT taker fee per side: 10 bps (0.10%). */
export const DEFAULT_TAKER_FEE_RATE = 0.001;

/**
 * Safety multiplier for minProfitableSpacing(): a grid is only worth
 * running if each cycle clears the round-trip fee with headroom, not
 * by a fraction of a cent.
 */
export const MIN_SPACING_SAFETY_FACTOR = 1.5;

// Env overrides take a DECIMAL rate (e.g. 0.0003 = 3 bps), not bps and
// not percent. Values that don't parse, are negative, or exceed 1%
// (clearly a unit mistake) fall back to the default.
function envFeeRate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.01) return fallback;
  return parsed;
}

/** Maker fee rate per side. Overridable via GRVT_MAKER_FEE_RATE (decimal, e.g. 0.0005). */
export function makerFeeRate(): number {
  return envFeeRate('GRVT_MAKER_FEE_RATE', DEFAULT_MAKER_FEE_RATE);
}

/** Taker fee rate per side. Overridable via GRVT_TAKER_FEE_RATE (decimal, e.g. 0.001). */
export function takerFeeRate(): number {
  return envFeeRate('GRVT_TAKER_FEE_RATE', DEFAULT_TAKER_FEE_RATE);
}

/**
 * Fee cost in USDT of one full grid round-trip (buy leg + sell leg).
 * Same formula the backtester charges per round trip:
 *   fee = (buyPrice + sellPrice) * qty * feeRate
 * Grid orders rest on the book, so the maker rate is the right default.
 */
export function roundTripFeeUsdt(
  buyPrice: number,
  sellPrice: number,
  qty: number,
  feeRate: number = makerFeeRate()
): number {
  return (buyPrice + sellPrice) * qty * feeRate;
}

/**
 * Minimum grid spacing (in USDT) for a round-trip to be profitable:
 *
 *   profit per cycle  = spacing * qty
 *   fee per cycle     ≈ (buy + sell) * qty * feeRate ≈ 2 * mid * qty * feeRate
 *
 * Requiring profit > fee * safetyFactor, qty cancels out:
 *
 *   spacing > 2 * mid * feeRate * safetyFactor
 *
 * so the floor depends only on price and fee rate — any grid below it
 * loses money on EVERY cycle regardless of order size.
 */
export function minProfitableSpacing(
  midPrice: number,
  feeRate: number = makerFeeRate(),
  safetyFactor: number = MIN_SPACING_SAFETY_FACTOR
): number {
  return 2 * midPrice * feeRate * safetyFactor;
}
