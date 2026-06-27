// Config advisor (V1a) — robustness scoring. Pure, deterministic, no I/O.
//
// The whole point of the advisor is to rank candidate configs by SURVIVAL
// across regimes, NOT by the best single backtest (that's overfitting). Each
// candidate is backtested over K sub-windows; we aggregate those into
// robustness stats and a comparator that ranks worst-case first.

export interface WindowResult {
  /** Net return for this window, as % of investment. */
  retPct: number;
  /** Max drawdown for this window, as %. */
  maxDDPct: number;
}

export interface RobustnessStats {
  meanRetPct: number;
  medianRetPct: number;
  /** Worst single-window return — the survival metric. */
  worstRetPct: number;
  bestRetPct: number;
  /** % of windows with a positive return. */
  winRatePct: number;
  /** Worst (largest) max drawdown across windows. */
  worstMaxDrawdownPct: number;
  windows: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Aggregate per-window backtest results into robustness stats. Returns null
 * for an empty input.
 */
export function aggregateWindows(results: WindowResult[]): RobustnessStats | null {
  if (!Array.isArray(results) || results.length === 0) return null;
  const rets = results.map((r) => r.retPct);
  const dds = results.map((r) => r.maxDDPct);
  return {
    meanRetPct: rets.reduce((s, v) => s + v, 0) / rets.length,
    medianRetPct: median(rets),
    worstRetPct: Math.min(...rets),
    bestRetPct: Math.max(...rets),
    winRatePct: (rets.filter((v) => v > 0).length / rets.length) * 100,
    worstMaxDrawdownPct: Math.max(...dds),
    windows: results.length,
  };
}

/**
 * Comparator for ranking candidates by ROBUSTNESS (use with Array.sort, best
 * first).
 *
 * VIABILITY FIRST: a config with positive expectancy (mean return > 0) always
 * ranks above one without it. Without this, pure worst-case ordering puts a
 * config that NEVER wins (shallow worst-case, mean ≤ 0) above one that wins
 * most windows with a much better mean but a deeper single-window worst-case —
 * burying the actually-profitable answer (caught live: a narrow losing range
 * outranked a wide profitable one).
 *
 * WITHIN a viability group: worst-case return (survival) → win-rate → mean.
 * Peak/best return is deliberately NOT a ranking key — chasing it overfits.
 */
export function compareRobustness(a: RobustnessStats, b: RobustnessStats): number {
  const aViable = a.meanRetPct > 0;
  const bViable = b.meanRetPct > 0;
  if (aViable !== bViable) return aViable ? -1 : 1; // profitable first
  if (a.worstRetPct !== b.worstRetPct) return b.worstRetPct - a.worstRetPct;
  if (a.winRatePct !== b.winRatePct) return b.winRatePct - a.winRatePct;
  return b.meanRetPct - a.meanRetPct;
}

/**
 * Confidence bucket from robustness, for the UI. Deliberately coarse
 * (High/Med/Low) and derived from observable survival stats — NOT a fake
 * calibrated probability (miscalibrated % confidence destroys user trust).
 */
export function confidenceBucket(stats: RobustnessStats): 'high' | 'med' | 'low' {
  if (stats.winRatePct >= 75 && stats.worstRetPct > -10) return 'high';
  if (stats.winRatePct >= 50 && stats.worstRetPct > -25) return 'med';
  return 'low';
}
