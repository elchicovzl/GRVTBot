// Config advisor (V1b) — orchestration. Pure: takes candles in, returns ranked
// recommendations out (no network — the endpoint fetches candles and calls
// this). Composes the V1a brain (regime + robustness) with the existing ATR
// derivation and the realistic backtester.
//
// Pipeline: GENERATE candidate configs from volatility math → GATE the grid
// direction on the regime (go/no-go) → SCORE each candidate by walk-forward
// robustness across K sub-windows (worst-case + win-rate, NOT peak return) →
// rank and return the top N with reason codes + honest assumptions.

import type { BacktestCandle } from './backtester.js';
import { runBacktest } from './backtester.js';
import { deriveAtrSpacing, type AtrCandle } from './atr.js';
import { classifyRegime, gridVerdict, type AdvisorVerdict, type RegimeState } from './regime.js';
import {
  aggregateWindows, compareRobustness, confidenceBucket,
  type RobustnessStats, type WindowResult,
} from './robustness.js';

export interface AdvisorParams {
  pair: string;
  direction: 'long' | 'short';
  investmentUSDT: number;
  leverage: number;
  /** Optional user range. When absent, the advisor proposes one from recent high/low. */
  lowerPrice?: number;
  upperPrice?: number;
  /** Constant funding per 8h for the sim (GRVT has no historical funding). Default 0.0001. */
  fundingRatePer8h?: number;
  /** ATR k multipliers to try. Default [0.6, 0.8, 1.0, 1.5]. */
  kMultipliers?: number[];
  /** Walk-forward sub-windows. Default 3. */
  windows?: number;
  /** How many ranked recommendations to return. Default 3. */
  topN?: number;
}

export interface AdvisorRecommendation {
  rank: number;
  config: {
    lowerPrice: number;
    upperPrice: number;
    numGrids: number;
    spacingPct: number;
    direction: 'long' | 'short';
    rangeSource: 'user' | 'recent';
    k: number;
  };
  robustness: RobustnessStats;
  perWindow: WindowResult[];
  reasonCodes: string[];
  confidence: 'high' | 'med' | 'low';
  /** Full-window equity curve (rank 1 only), thinned for charting. */
  equityCurve?: Array<{ time: number; equity: number }>;
}

/** Why the verdict landed where it did — drives the UI copy. */
export type AdvisorReason = 'favorable' | 'regime_against' | 'regime_with_trend' | 'weak_backtest';

export interface AdvisorResult {
  regime: { state: RegimeState; efficiencyRatio: number; trendPct: number; window: number };
  verdict: AdvisorVerdict;
  /** Dominant cause of the verdict (regime vs backtest evidence). */
  verdictReason: AdvisorReason;
  recommendations: AdvisorRecommendation[];
  assumptions: {
    lookbackCandles: number;
    windows: number;
    fundingRatePer8h: number;
    fundingModel: string;
    candidatesEvaluated: number;
  };
}

const DEFAULT_KS = [0.6, 0.8, 1.0, 1.5];
const MIN_WINDOW_CANDLES = 30;

const VERDICT_SEVERITY: Record<AdvisorVerdict, number> = { recommend: 0, caution: 1, no_go: 2 };

/**
 * Verdict implied by the BEST candidate's backtest evidence — independent of
 * the regime label. This is the fix for the trap where the regime gate calls a
 * choppy −33% market "range" (low efficiency ratio) and says "recommend" while
 * every candidate actually LOST in every window. Evidence overrides heuristic.
 */
export function robustnessVerdict(best: RobustnessStats | undefined): AdvisorVerdict {
  if (!best) return 'caution';                          // no scoring → can't endorse
  if (best.meanRetPct <= 0 || best.winRatePct === 0) return 'no_go'; // loses on average / never wins
  if (best.winRatePct < 50 || best.worstRetPct <= -20 || confidenceBucket(best) === 'low') return 'caution';
  return 'recommend';
}

/** Split candles into up to `n` consecutive sub-windows (each >= MIN_WINDOW_CANDLES). */
function splitWindows(candles: BacktestCandle[], n: number): BacktestCandle[][] {
  const size = Math.floor(candles.length / n);
  if (size < MIN_WINDOW_CANDLES) {
    return candles.length >= MIN_WINDOW_CANDLES ? [candles] : [];
  }
  const out: BacktestCandle[][] = [];
  for (let i = 0; i < n; i++) {
    out.push(candles.slice(i * size, i === n - 1 ? candles.length : (i + 1) * size));
  }
  return out;
}

/** Thin an equity curve to ~maxPoints, always keeping first + last. */
function thinCurve(curve: Array<{ time: number; equity: number }>, maxPoints = 200): Array<{ time: number; equity: number }> {
  if (curve.length <= maxPoints) return curve;
  const stride = Math.ceil(curve.length / maxPoints);
  const out = curve.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== curve[curve.length - 1]) out.push(curve[curve.length - 1]!);
  return out;
}

export function runAdvisor(candles: BacktestCandle[], params: AdvisorParams): AdvisorResult | null {
  if (!Array.isArray(candles) || candles.length < MIN_WINDOW_CANDLES) return null;

  const ks = params.kMultipliers ?? DEFAULT_KS;
  const nWindows = params.windows ?? 3;
  const topN = params.topN ?? 3;
  const funding = params.fundingRatePer8h ?? 0.0001;
  const { pair, direction, investmentUSDT, leverage } = params;

  const closes = candles.map((c) => c.close);
  const atrCandles: AtrCandle[] = candles.map((c) => ({ high: c.high, low: c.low, close: c.close }));

  // ── GATE: regime + go/no-go on the chosen direction ────────────────
  const regime = classifyRegime(closes);
  if (!regime) return null;
  // Regime-based verdict (heuristic). Combined with the backtest evidence below.
  const gateVerdict = gridVerdict(regime.state, direction);

  // ── GENERATE: range options × ATR k → candidate configs ────────────
  const recentLow = Math.min(...candles.map((c) => c.low));
  const recentHigh = Math.max(...candles.map((c) => c.high));
  const ranges: Array<{ lower: number; upper: number; source: 'user' | 'recent' }> = [];
  if (params.lowerPrice != null && params.upperPrice != null && params.lowerPrice < params.upperPrice) {
    ranges.push({ lower: params.lowerPrice, upper: params.upperPrice, source: 'user' });
  }
  ranges.push({
    lower: Math.round(recentLow * 0.999 * 100) / 100,
    upper: Math.round(recentHigh * 1.001 * 100) / 100,
    source: 'recent',
  });

  // Candidate = (range, numGrids). Dedup configs that collapse to the same
  // (range, numGrids) after ATR clamping.
  interface Candidate { lower: number; upper: number; source: 'user' | 'recent'; numGrids: number; spacingPct: number; k: number }
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const r of ranges) {
    for (const k of ks) {
      const atr = deriveAtrSpacing(atrCandles, r.lower, r.upper, { multiplier: k });
      if (!atr) continue;
      const key = `${r.lower}|${r.upper}|${atr.numGrids}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ lower: r.lower, upper: r.upper, source: r.source, numGrids: atr.numGrids, spacingPct: atr.spacingPct, k });
    }
  }

  // ── SCORE: walk-forward robustness across sub-windows ──────────────
  const windows = splitWindows(candles, nWindows);
  const scored = candidates.map((c) => {
    const perWindow: WindowResult[] = windows.map((win) => {
      const r = runBacktest(
        { pair, direction, leverage, lowerPrice: c.lower, upperPrice: c.upper, numGrids: c.numGrids, investmentUSDT, fundingRatePer8h: funding },
        win
      );
      return { retPct: (r.netProfit / investmentUSDT) * 100, maxDDPct: r.maxDrawdownPct };
    });
    return { c, perWindow, stats: aggregateWindows(perWindow)! };
  }).filter((s) => s.stats);

  scored.sort((a, b) => compareRobustness(a.stats, b.stats));

  // ── VERDICT: the WORSE of the regime gate and the backtest evidence ─
  // A green "recommend" must never survive a best candidate that lost in every
  // window. Evidence (robustness of the top pick) overrides the regime label.
  const bestStats = scored[0]?.stats;
  const robV = robustnessVerdict(bestStats);
  const verdict: AdvisorVerdict =
    VERDICT_SEVERITY[robV] > VERDICT_SEVERITY[gateVerdict] ? robV : gateVerdict;
  let verdictReason: AdvisorReason;
  if (gateVerdict === 'no_go') verdictReason = 'regime_against';            // regime trend against the grid
  else if (VERDICT_SEVERITY[robV] >= VERDICT_SEVERITY[gateVerdict] && robV !== 'recommend') verdictReason = 'weak_backtest';
  else if (gateVerdict === 'caution') verdictReason = 'regime_with_trend';
  else verdictReason = 'favorable';

  // ── BUILD recommendations ──────────────────────────────────────────
  const recommendations: AdvisorRecommendation[] = scored.slice(0, topN).map((s, i) => {
    const codes = [
      `regime:${regime.state}`,
      `ER:${regime.efficiencyRatio.toFixed(2)}`,
      `k:${s.c.k}`,
      `grids:${s.c.numGrids}`,
      `spacing:${s.c.spacingPct.toFixed(2)}%`,
      `worst:${s.stats.worstRetPct.toFixed(1)}%`,
      `winRate:${s.stats.winRatePct.toFixed(0)}%`,
      `range:${s.c.source}`,
    ];
    const rec: AdvisorRecommendation = {
      rank: i + 1,
      config: {
        lowerPrice: s.c.lower, upperPrice: s.c.upper, numGrids: s.c.numGrids,
        spacingPct: s.c.spacingPct, direction, rangeSource: s.c.source, k: s.c.k,
      },
      robustness: s.stats,
      perWindow: s.perWindow,
      reasonCodes: codes,
      confidence: confidenceBucket(s.stats),
    };
    if (i === 0) {
      // Full-window equity curve for the top pick, thinned for the chart.
      const full = runBacktest(
        { pair, direction, leverage, lowerPrice: s.c.lower, upperPrice: s.c.upper, numGrids: s.c.numGrids, investmentUSDT, fundingRatePer8h: funding },
        candles
      );
      rec.equityCurve = thinCurve(full.equityCurve);
    }
    return rec;
  });

  return {
    regime: { state: regime.state, efficiencyRatio: regime.efficiencyRatio, trendPct: regime.trendPct, window: regime.window },
    verdict,
    verdictReason,
    recommendations,
    assumptions: {
      lookbackCandles: candles.length,
      windows: windows.length,
      fundingRatePer8h: funding,
      fundingModel: 'constant per-8h (GRVT publishes no historical funding rate)',
      candidatesEvaluated: candidates.length,
    },
  };
}
