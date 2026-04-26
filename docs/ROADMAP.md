# GRVT Grid — Roadmap

> **Last updated**: 2026-04-25
> **Current state**: Phases A-H complete. Bots running in production (ETH 10x + SOL virtual grids 10x). Phase I (Lumina) paused.

---

## Completed

### Phase A — Grid Engine ✅
Core grid trading engine on GRVT perpetual futures. LONG/SHORT strategies, post-only orders with retry, fill deduplication, rate-limit handling.

### Phase B — Dashboard + Multi-Tenancy ✅
Full SPA (Vite + React + Tailwind + shadcn). GridChart with candle + grid overlays, equity curve, sparklines, 4-step create-bot wizard, live range update with preview, compound rebalancing, roundtrip tracking via FIFO fill pairing, multi-tenant auth (JWT + encrypted credentials), Docker self-host kit, Telegram notifier, light/dark theme.

### Phase C — Hardening & Reliability ✅
All 10/10 deployed. Structured logging (pino), per-user GRVT clients, liquidation safeguard, graceful shutdown, deep health check, pagination, processedFills pruning, one-bot-per-instrument guard, notifier health.

### Phase D — Test Suite (partial)
- D.2 + D.3 deployed (58 tests covering REST API + grid calculation).
- D.1, D.4-D.9 still pending (see below).

### Phase E — Dashboard Polish ✅
E.1-E.9 done. E.9 (password recovery) ships SMTP-based reset with optional config — if SMTP env vars are blank, reset URL is logged at WARN for out-of-band delivery so self-host without SMTP still works.

### Phase F — Notifications & Alerting ✅ (5/6)
F.1-F.4 + F.6 deployed: per-bot thresholds, liq proximity, webhook sink, muted hours, alert history. **F.5 (email) skipped — Telegram is sufficient for current users**.

### Phase G — Operations & Monitoring ✅
All 6/6 deployed: Prometheus metrics, Grafana template, automated backups, rollback docs, log rotation, connection-loss docs.

### Phase H — Advanced Trading ✅
- **H.2 — Dynamic grid (auto-shift)**: opt-in per bot. When mark price exits the range by >= `auto_shift_pct` of range width, monitor sets `autoShiftRequested`; the engine handler re-centers the range on current price (same width) by reusing `updateBotRange()`. Rate-limited to once per hour via persisted `last_auto_shift_at`. Emits `autoShifted` event → WS notification. Dashboard shows status card on bot detail when enabled.
- **H.3 — Stop-loss / take-profit**: opt-in per bot via `sl_pct`/`tp_pct` (% of `investment_usdt`). Engine throws `SAFEGUARD:pause_close` when crossed; `monitorAllBots` catches and routes to `closeBot`. Dashboard exposes editable card on bot detail (PATCH `/bots/:id/risk`) — clearing the field disables the guard. Critical bug fix shipped: previous `updatePnL` catch silently swallowed the SAFEGUARD throw, so SL/TP never fired.
- **H.8 — Virtual Grids**: user can configure up to 500 grid levels; engine maintains an "active window" of N closest-to-price levels (default 70, max 80 = GRVT cap minus margin) with the rest as `state='virtual'`. Window rotates as price moves: closer levels activate, farther ones get cancelled and demoted. Initial purchase counts ALL sell levels (incl virtuals) so backing is correct from day one. Schema: `grid_bots.virtual_enabled`, `grid_bots.active_window_size`, `grid_levels.state`.
- Dashboard: virtual levels render as dotted muted lines on the chart, stats strip shows `N active · M virtual · K filled`, "VIRTUAL" entry in chart legend.

### Profit audit + unification ✅ (2026-04-14)
`paired_roundtrips.bot_id` added with backfill; single source of truth for grid profit (`SUM(profit) - SUM(fees)`); fixed cross-bot contamination.

### Critical fixes (2026-04-25)
- **Grid-coverage tolerance bug**: monitor's match tolerance was hardcoded `< 0.5` USD. With $0.25 grid step on SOL bot, a single GRVT order aliased to two adjacent DB levels → loser got re-placed → duplicates. Fixed: `matchTolerance = min(0.05, gridStep / 3)` per bot.
- **Dup killer hardening**: threshold tightened from `active_window_size` to actual `expectedActiveLevels.length`. Added orphan detection that cancels GRVT orders whose price doesn't match any expected DB level.
- **Fill detection**: monitor now checks both REST `getFillHistory` AND local WS-backed `fills_archive` before the 10s GRVT-lag skip — catches aggressive-candle fills inside the skip window.
- **Bootstrap race conditions**: `bootstrapInProgress` + `bootstrapAbort` flags, gap-level marking at open, removed redundant SELL placement.
- **Server access**: root `/` redirects to `/dashboard/`, basic auth skipped for SPA paths (the v2 app has its own JWT login).

---

## Pending

### Phase D (remaining)
| # | Task | Scope | Est |
|---|------|-------|-----|
| D.1 | Bot lifecycle integration test | `tests/integration/` | 2h |
| D.4 | Compound rebalance tests | `tests/grid-engine.test.ts` | 1h |
| D.5 | Range update tests | `tests/range-update.test.ts` | 2h |
| D.6 | DB migration tests | `tests/db.test.ts` | 1h |
| D.7 | Notifier tests | `packages/notifier/tests/` | 1h |
| D.8 | Dashboard component tests | `packages/dashboard/tests/` | 2h |
| D.9 | WebSocket tests | `tests/ws.test.ts` | 1h |

### Phase H (next-gen, all new)
| # | Task | Why | Est |
|---|------|-----|-----|
| H.5 | **Multi-sub-account** — connect multiple GRVT sub-accounts, run bots on each | Power-user isolation between strategies | 3h |
| H.6 | **Backtesting** — simulate grid on historical candles | Test parameters before risking capital | 8h |
| H.7 | **Portfolio view** — aggregate equity / PnL / risk across all bots | Overview lacks aggregate stats | 3h |

### Phase I — Lumina Insurance Integration (paused)
Plan exists at `~/.claude/plans/effervescent-sparking-lamport.md`. Deferred until Lumina vaults have non-zero TVL and/or a GRVT-specific product exists. Flash Insurance economics don't close yet for small-capital bots at low leverage.

---

## Priority order (recommended next)

```
1. H.5 — Multi-sub-account       (~3h, schema ready)
2. H.7 — Portfolio view          (~3h, lifts overview UX)
3. D remainders                  (~10h, test coverage)
4. H.6 — Backtesting             (~8h, big feature)
```

Phase I (Lumina) waits for protocol maturity. No work scheduled.

---

## Production state (Apr 25)

- **Bot 44**: ETH_USDT_Perp · LONG · 10x · 94 grids · realized $53+ · running
- **Bot 48**: SOL_USDT_Perp · LONG · 10x · 120 virtual grids (window 70) · $100 invested · running
- **VPS**: 46.62.149.136 port 3848 (caddy not in use; direct dashboard at `/dashboard/`)
- **DB**: SQLite WAL at `/opt/grvt-grid-bot/data/grid_bot.db`
- Service: systemd `grvt-grid-bot.service` (user `grvtbot`) + `grvt-grid-notifier.service`
