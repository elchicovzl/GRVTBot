# Config Advisor — Design Spec (v0.1)

Status: **proposed**. Decisions confirmed with the maintainer are marked ✅.

## 1. Goal & principles

Before a user creates a grid bot, the advisor backtests candidate configurations
and **recommends the most ROBUST one** (range, number of grids, spacing,
direction, and go/no-go), instead of the user choosing everything blind.

Principles (non-negotiable — real money):
- **Robustness > peak return.** Never pick "what performed best in one window" → that's overfitting.
- **Advisor, not autopilot.** It recommends; the human approves. Approve and Customize are **equal cost** (no pre-armed "create" default).
- **Visible honesty.** Show assumptions, worst-case (drawdown), regime, and the "why". The backtester assumes **constant funding** (GRVT publishes no historical funding) — say so.
- **Regime is destiny.** A long grid in a downtrend loses regardless of grid count (validated: win-rate ~67% across all `k`; the losses were always the bear windows). The most valuable advice can be "don't run this here."

✅ **Decision:** the regime gate may return a verdict (`recommend` / `caution` / `no_go`) and suggest a different direction or range — not just tune the grid.

## 2. Architecture (4 stages) — reuses what already exists

```
GENERATE candidates → GATE by regime → SCORE by robustness → PRESENT (card + approve/override)
```

Reuses: `runBacktest()` (deterministic engine), `grvtClient.getKlines()` server-side
(already used by `/backtest`), `deriveAtrSpacing()`, and in the UI `<EquityCurve>` +
`<StatCard>`. New: `POST /api/v2/bots/advisor` endpoint + a wizard step.

### 2a. GENERATE — candidates from transparent volatility math
Copyable sources: **Binance** auto-params (range = Bollinger MA ± k·σ on daily
candles, k=3, cube-root lookback scaling) and the **ATR rule** (spacing ≈ fraction
of ATR, N ≈ range/ATR — already validated here). Every major treats selection as a
black box; **showing the "why" is our differentiator.**
- Range: (i) recent high/low, (ii) Bollinger(20, 2σ and 3σ) — over 2–3 lookbacks (7/30/90d).
- Grid count: ATR `k` sweep {0.6, 0.8, 1.0, 1.5} (validated that `k`>0.6 beats the blog's 0.6) + a couple of fixed counts.
- Direction: the user's; the gate may suggest changing it or not running.
- **Modest** candidate set (≤ ~12) to limit multiple-testing.

### 2b. GATE — regime (go/no-go/direction)
No single indicator gives both regime and direction. Two-part, lightweight (short window):
- **State (range vs trend):** Efficiency Ratio (Kaufman) and/or Choppiness Index.
- **Direction:** sign of the MA / regression slope.
- Rule: strong trend AGAINST the grid direction → downgrade to `no_go` or suggest the opposite direction / a wider range.
- Thresholds **calibrated by per-instrument percentile**, not hardcoded (0.3/25/61.8 are conventions, not laws).
- Report the regime classification to the user as part of the "why".

### 2c. SCORE — robustness (NOT peak return)
- **Walk-forward-lite:** evaluate each candidate over K sub-windows (different regimes), not a single backtest. Per-candidate: mean/median/**worst-case** return, **win-rate** (% profitable windows), **maxDrawdown** (worst).
- **Plateau:** reward candidates whose ±1 neighbors (in grid-count / range space) also perform well; penalize "cliff" configs (overfit).
- **Multiple-testing awareness:** small candidate set + present as "robust across N regimes", not "the best". (V2: deflated-Sharpe / PBO penalty.)
- Primary ranking: **worst-case + win-rate** (survival), return secondary. Show both so the honesty is visible.

### 2d. PRESENT — UX (appropriate reliance, not max trust)
- **Recommendation card:** confidence as **High/Med/Low** (only if calibrated), regime classification, labeled **worst-case drawdown** (fan-chart/band, not a single line), and short **reason codes** ("neutral because regime=range, ER=0.22, flat slope").
- **Approve and Customize = equal cost.** Do NOT pre-arm "start bot".
- **Cognitive forcing** before going live: show the worst-case and require an explicit risk acknowledgment (appropriate for an irreversible capital action).
- **Override always** (range/grids/spacing/direction) + **log** the recommendation + decision (audit + detect rubber-stamping).

## 3. API

`POST /api/v2/bots/advisor` (JWT, **with a new rate-limit** — `/backtest` has none today and the advisor runs many backtests; cap candidates × windows + throttle to a few/min/user).

Request:
```
{ pair, direction, investment_usdt, leverage,
  lower_price?, upper_price?,   // optional: if absent, the advisor proposes a range
  lookbacks_days?: number[],    // default [7,30,90]
  risk?: 'conservative'|'balanced'|'aggressive' }
```
Response:
```
{ regime: { state: 'range'|'trend_up'|'trend_down', efficiencyRatio, slopePct, confidence },
  verdict: 'recommend'|'caution'|'no_go',
  recommendations: [{
     rank, config: { lower, upper, num_grids, spacingPct, direction, atr:{...} },
     robustness: { meanRetPct, medianRetPct, worstRetPct, winRatePct, worstMaxDrawdownPct },
     reasonCodes: string[], confidence,
     perWindow: [{ regime, retPct, maxDDPct }],
     equityCurve: [...] },  // representative, thinned
  ],
  assumptions: { lookbacksDays, fundingModel: 'constant 0.01%/8h (GRVT publishes no history)', feesBps, slippageBps, windows } }
```

## 4. UI

New wizard step **"Advisor"** between Range (step 1) and Config (step 2):
- "Get recommendation" button → calls the endpoint → shows the card.
- `no_go`: clear banner + option to continue manually anyway (override).
- "Apply" pre-fills the Config step; "Customize" continues manual. Same visual weight.
- Reuse `<EquityCurve>` and `<StatCard>`. Reuse the existing "Apply to Wizard" pattern from the backtest page.

## 5. Phasing

✅ **Decision:** commit this spec, then build V1 incrementally (one branch+PR per part).

- **V1a:** pure modules — regime indicators (Efficiency Ratio, slope) + robustness scorer (multi-window worst-case/win-rate/plateau). Unit-tested, deterministic. No network, no UI.
- **V1b:** `POST /api/v2/bots/advisor` endpoint (GENERATE + GATE + SCORE, reusing getKlines/runBacktest/deriveAtrSpacing) + rate-limit + integration tests.
- **V1c:** wizard "Advisor" step + recommendation card (reusing EquityCurve/StatCard) + approve/override + risk ack.
- **V2 (later):** Monte-Carlo worst-case DD (block-bootstrap — naive understates DD), multiple-testing penalty (deflated-Sharpe/PBO), per-instrument percentile thresholds, short/neutral candidate generation, fan-charts, formal confidence calibration, Bollinger candidate generation.

## 6. Risks / open decisions
- **Backtester fidelity:** funding is a constant (GRVT has no history) and funding DOMINATES results → every recommendation is only as honest as that assumption. Surface it. `maxDrawdownPct` > 100% and `profitFactor` = Infinity are backtester quirks to review.
- **Confidence calibration:** do NOT show confidence if it isn't calibrated (miscalibrated confidence destroys trust). V1 uses simple buckets derived from win-rate/worst-case, not a fake "%".
- **Multiple testing:** keep the candidate set small in V1.
- **Anchored vs rolling windows, regime thresholds:** no academic consensus → tunable, not hardcoded.

## 7. Testing
- Unit: new indicators (Efficiency Ratio, slope, plateau score) against hand-computed values (like ATR).
- Unit: robustness scorer (worst-case/win-rate/ranking) — deterministic.
- Integration: advisor endpoint with mocked `getKlines` (synthetic candles of a known regime → expected verdict).
- Repo rule: every PR ships a regression test.

## References
Research with sources is captured in the project memory (engram: "Spec v0.1 del Config Advisor" / "Sweep multi-régimen ATR k"). Key external anchors: Pardo walk-forward; López de Prado CPCV / deflated Sharpe / PBO; Binance auto-params; Kaufman Efficiency Ratio; Choppiness Index; Google PAIR + Microsoft HAX for the UX.
