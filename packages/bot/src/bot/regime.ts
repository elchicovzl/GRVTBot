// Config advisor (V1a) — market regime detection. Pure, deterministic, no I/O.
//
// A grid profits from oscillation inside a range and BLEEDS in a strong trend
// (a long grid mechanically buys all the way down a downtrend). So before
// recommending a grid we classify the recent regime and gate the verdict on it.
//
// Two lightweight signals (best-fit for short recent-candle windows):
//   - Kaufman Efficiency Ratio (ER): range-vs-trend STATE, bounded 0..1.
//   - Least-squares slope of closes: DIRECTION (sign) + magnitude.
// No single indicator gives both, so we combine them.
//
// Thresholds are CONVENTIONS, not laws — exposed as tunable params (V2 will
// calibrate them per-instrument by percentile).

export interface RegimeThresholds {
  /** ER at/above which the market is "trending". Default 0.5. */
  erTrend?: number;
  /** Minimum |trend %| over the window to call it directional. Default 5%. */
  slopeMinPct?: number;
}

export type RegimeState = 'trend_up' | 'trend_down' | 'range';

export interface RegimeClassification {
  state: RegimeState;
  /** Kaufman ER over the window (0..1). */
  efficiencyRatio: number;
  /** Net trend over the window as % of the mean price (signed). */
  trendPct: number;
  /** Number of closes used. */
  window: number;
}

/**
 * Kaufman Efficiency Ratio over the whole `closes` series:
 *   ER = |close[n-1] - close[0]| / Σ |close[i] - close[i-1]|
 * 1 = perfectly directional, ~0 = pure noise/oscillation. Returns null with
 * < 2 points; returns 0 when the path is flat (no movement → no trend).
 */
export function efficiencyRatio(closes: number[]): number | null {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  let pathSum = 0;
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i]!, b = closes[i - 1]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    pathSum += Math.abs(a - b);
  }
  if (pathSum === 0) return 0;
  const net = Math.abs(closes[closes.length - 1]! - closes[0]!);
  return net / pathSum;
}

/**
 * Least-squares slope of `values` against index 0..n-1 (per-bar change).
 * Returns null with < 2 points or zero x-variance.
 */
export function linregSlope(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const y = values[i]!;
    if (!Number.isFinite(y)) return null;
    sx += i; sy += y; sxx += i * i; sxy += i * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

/**
 * Classify the regime of a closes series. ER gives the trend/range state;
 * the regression slope gives the direction. The market is "trending" only
 * when BOTH ER is high AND the net move clears slopeMinPct; otherwise it's
 * treated as a range (the grid-friendly case).
 */
export function classifyRegime(
  closes: number[],
  thresholds: RegimeThresholds = {}
): RegimeClassification | null {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const erTrend = thresholds.erTrend ?? 0.5;
  const slopeMinPct = thresholds.slopeMinPct ?? 5;

  const er = efficiencyRatio(closes);
  const slope = linregSlope(closes);
  if (er === null || slope === null) return null;

  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  // Net trend over the window from the fitted line, as % of the mean price.
  const trendPct = mean !== 0 ? (slope * (closes.length - 1) / mean) * 100 : 0;

  let state: RegimeState = 'range';
  if (er >= erTrend && Math.abs(trendPct) >= slopeMinPct) {
    state = trendPct > 0 ? 'trend_up' : 'trend_down';
  }
  return { state, efficiencyRatio: er, trendPct, window: closes.length };
}

export type AdvisorVerdict = 'recommend' | 'caution' | 'no_go';

/**
 * Gate a grid direction against the regime:
 *   - trend AGAINST the grid (down for a long, up for a short) → no_go
 *     (the grid would buy/sell into a losing trend).
 *   - trend WITH the grid → caution (a runaway trend outruns the grid).
 *   - range → recommend (the grid-friendly case).
 */
export function gridVerdict(state: RegimeState, direction: 'long' | 'short'): AdvisorVerdict {
  if (state === 'range') return 'recommend';
  const against = direction === 'long' ? 'trend_down' : 'trend_up';
  return state === against ? 'no_go' : 'caution';
}
