// Bridges the bot's internal state to the WebSocket bus.
//
// This module is the ONLY place that knows how to translate engine events
// and DB state into the channel/message format that dashboard clients
// understand. The engine itself stays untouched.
//
// What it does:
//
// 1. **Engine event passthrough.** The GridEngine emits a handful of events
//    (`botCreated`, `botStarted`, `botPaused`, `botClosed`,
//    `botCloseFailed`, `safeguardTriggered`). For each, we publish a
//    corresponding bus message.
//
// 2. **Periodic state polling.** Every 1s we read the bot rows from the DB
//    and publish a `bot:N:tick` snapshot for any bot that's `running`. The
//    dashboard subscribes to `bot:N:tick` and gets a smooth stream of
//    PnL/position/equity updates without us needing to hook into every
//    internal mutation.
//
// 3. **Fill detection.** Every 2s we query the `paired_roundtrips` and
//    `fills_archive` tables for new entries since the last tick. New fills
//    get published to `bot:N:fill` (and to a global `fills` channel).
//
// 4. **Notifications.** Errors and warnings (e.g. safeguard triggered, GRVT
//    auth failed) get published to the `notifications` channel for the bell
//    icon in the header.
//
// All polling intervals are unref'd so they don't keep the process alive
// during shutdown.

import type { EventEmitter } from 'node:events';
import { wsBus } from './ws-bus.js';
import { childLogger } from './logger.js';
import type Database from 'sqlite3';

const log = childLogger('dispatcher');

// Type-only import for the bot row shape, kept loose to avoid coupling.
interface BotRow {
  id: number;
  pair: string;
  status: string;
  position_size: number;
  avg_entry_price: number;
  grid_profit_usdt: number;
  trend_pnl_usdt: number;
  total_pnl_usdt: number;
  liquidation_price: number;
  num_grids: number;
  investment_usdt: number;
}

interface PairedRoundtripRow {
  id: number;
  buy_fill_id: string;
  sell_fill_id: string;
  buy_price: number;
  sell_price: number;
  size: number;
  profit: number;
  created_at: string;
}

// G.4: minimal surface of GridBotDB the dispatcher needs to persist
// alerts. Typed structurally so tests can pass a tiny fake.
export interface AlertStore {
  recordAlert(params: {
    user_id: number;
    bot_id?: number | null;
    type: string;
    severity?: 'info' | 'warning' | 'critical';
    message: string;
  }): Promise<number>;
}

export interface DispatcherDeps {
  /** The GridEngine instance (or anything with .on(eventName, fn) — we type loosely to avoid pulling the giant grid-engine types in here). */
  engine: EventEmitter;
  /** A sqlite3 Database that has both `grid_bots` and `paired_roundtrips` tables. */
  db: Database.Database;
  /** G.4: optional persistent alert sink. When provided, safeguard/margin pauses and failed closes are written to the `alerts` table. */
  alertStore?: AlertStore;
  /** Polling interval for the per-bot state tick. Default 1000ms. */
  tickIntervalMs?: number;
  /** Polling interval for the fill detector. Default 2000ms. */
  fillIntervalMs?: number;
}

export class WsDispatcher {
  private engine: EventEmitter;
  private db: Database.Database;
  private alertStore: AlertStore | null;
  private tickIntervalMs: number;
  private fillIntervalMs: number;

  private tickTimer: NodeJS.Timeout | null = null;
  private fillTimer: NodeJS.Timeout | null = null;

  /** Highest paired_roundtrips.id we've already broadcast. */
  private lastBroadcastRoundtripId = 0;

  /** Cached previous bot snapshot per bot — used to avoid re-broadcasting unchanged data (saves bandwidth and keeps the UI animations meaningful). */
  private lastSnapshot = new Map<number, string>();  // botId -> JSON.stringify(snapshot)

  constructor(deps: DispatcherDeps) {
    this.engine = deps.engine;
    this.db = deps.db;
    this.alertStore = deps.alertStore ?? null;
    this.tickIntervalMs = deps.tickIntervalMs ?? 1000;
    this.fillIntervalMs = deps.fillIntervalMs ?? 2000;
  }

  // G.4: persist an alert row for the bot's owner. Fire-and-forget —
  // alert history must never break the event path that pauses bots.
  // Owner lookup mirrors the router's legacy policy: NULL user_id = 1.
  private persistAlert(
    botId: number,
    type: string,
    severity: 'info' | 'warning' | 'critical',
    message: string
  ): void {
    const store = this.alertStore;
    if (!store) return;
    this.db.get(
      `SELECT user_id FROM grid_bots WHERE id = ?`,
      [botId],
      (err: Error | null, row: { user_id: number | null } | undefined) => {
        if (err) {
          log.warn({ err: err.message, botId }, 'persistAlert: owner lookup failed');
          return;
        }
        const userId = row?.user_id ?? 1;
        store
          .recordAlert({ user_id: userId, bot_id: botId, type, severity, message })
          .catch((e: Error) => log.warn({ err: e.message, botId }, 'persistAlert: insert failed'));
      }
    );
  }

  start(): void {
    this.attachEngineListeners();
    this.startTickPoller();
    this.startFillPoller();
    log.info({ tickMs: this.tickIntervalMs, fillMs: this.fillIntervalMs }, 'dispatcher started');
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.fillTimer) clearInterval(this.fillTimer);
    this.tickTimer = null;
    this.fillTimer = null;
    log.info('dispatcher stopped');
  }

  // ─── Engine event passthroughs ────────────────────────────────────────
  private attachEngineListeners(): void {
    this.engine.on('botCreated', (payload: { botId: number }) => {
      wsBus.publish(`bot:${payload.botId}`, 'botCreated', payload);
      wsBus.publish('bots', 'botCreated', payload);
      wsBus.publish('notifications', 'botCreated', payload);
    });

    this.engine.on('botStarted', (payload: { botId: number }) => {
      wsBus.publishToMany([`bot:${payload.botId}`, 'bots', 'notifications'], 'botStarted', payload);
    });

    this.engine.on('botPaused', (payload: { botId: number }) => {
      wsBus.publishToMany([`bot:${payload.botId}`, 'bots', 'notifications'], 'botPaused', payload);
    });

    this.engine.on('botClosed', (payload: { botId: number }) => {
      wsBus.publishToMany([`bot:${payload.botId}`, 'bots', 'notifications'], 'botClosed', payload);
    });

    // Cierre que NO logró flatear la posición dentro del límite (fail-closed):
    // el bot quedó en 'paused' con posición residual y la orden de cierre GTC
    // sigue viva. Alerta para que el operador intervenga manualmente.
    this.engine.on('botCloseFailed', (payload: {
      botId: number;
      residualSize: number;
      pair: string;
      closeOrderId: string | null;
      reason: string;
    }) => {
      log.error({ ...payload }, 'bot close failed — position not flat');
      // G.4: durable record — a non-flat close is exactly the kind of
      // 3am event the user must be able to find later.
      this.persistAlert(
        payload.botId,
        'close_failed',
        'critical',
        `Close failed (residual ${payload.residualSize} ${payload.pair}): ${payload.reason}`
      );
      wsBus.publishToMany(
        [`bot:${payload.botId}`, 'bots', 'notifications'],
        'botCloseFailed',
        payload
      );
    });

    this.engine.on('safeguardTriggered', (payload: {
      botId: number;
      action?: string;
      reason?: string;
      error: string;
    }) => {
      log.warn({ ...payload }, 'safeguard triggered');
      // G.4: persist the pause. The engine reuses this event for both
      // SAFEGUARD (liq proximity, SL/TP) and the MARGIN brake — derive
      // the alert type from the structured reason string.
      const reason = payload.reason ?? payload.error ?? '';
      const type = reason.includes('MARGIN:') ? 'margin_pause' : 'safeguard';
      this.persistAlert(payload.botId, type, 'critical', reason || 'safeguard triggered');
      wsBus.publishToMany(
        [`bot:${payload.botId}`, 'bots', 'notifications'],
        'safeguardTriggered',
        payload
      );
    });

    // Backfill reconciliation: the live GRVT position diverged from the
    // grid-implied expectation beyond tolerance after a fill backfill.
    // The engine deliberately does NOT auto-trade the residual away —
    // this alert is the durable record the operator must act on.
    this.engine.on('positionDrift', (payload: {
      botId: number;
      pair: string;
      liveSize: number;
      expectedSize: number;
      drift: number;
      tolerance: number;
    }) => {
      log.error({ ...payload }, 'position drift detected after backfill');
      this.persistAlert(
        payload.botId,
        'position_drift',
        'critical',
        `Position drift on ${payload.pair}: live ${payload.liveSize} vs grid-implied ${payload.expectedSize.toFixed(6)} ` +
        `(drift ${payload.drift.toFixed(6)} > tolerance ${payload.tolerance.toFixed(6)}). Not auto-corrected — review manually.`
      );
      wsBus.publishToMany(
        [`bot:${payload.botId}`, 'bots', 'notifications'],
        'positionDrift',
        payload
      );
    });

    // H.2: auto-shift completed. Surfaces in the dashboard's notification
    // bell so the user knows the grid moved without having to diff the
    // chart manually.
    this.engine.on('autoShifted', (payload: {
      botId: number;
      fromRange: { lower: number; upper: number };
      toRange: { lower: number; upper: number };
      currentPrice: number;
      exitDist: number;
    }) => {
      log.info({ ...payload }, 'auto-shift completed');
      wsBus.publishToMany(
        [`bot:${payload.botId}`, 'bots', 'notifications'],
        'autoShifted',
        payload
      );
    });
  }

  // ─── Per-bot state tick poller ────────────────────────────────────────
  private startTickPoller(): void {
    this.tickTimer = setInterval(() => {
      this.broadcastBotTicks().catch((err) => log.error({ err }, 'tick broadcast failed'));
    }, this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  private broadcastBotTicks(): Promise<void> {
    return new Promise((resolve) => {
      this.db.all<BotRow>(
        `SELECT id, pair, status, position_size, avg_entry_price,
                grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt,
                liquidation_price, num_grids, investment_usdt
         FROM grid_bots`,
        (err, rows) => {
          if (err) {
            log.error({ err: err.message }, 'tick query failed');
            return resolve();
          }
          for (const bot of rows) {
            const snapshot = {
              id: bot.id,
              status: bot.status,
              positionSize: bot.position_size,
              avgEntryPrice: bot.avg_entry_price,
              gridProfit: bot.grid_profit_usdt,
              trendPnl: bot.trend_pnl_usdt,
              totalPnl: bot.total_pnl_usdt,
              liquidationPrice: bot.liquidation_price,
              ts: Date.now()
            };
            const serialized = JSON.stringify(snapshot);
            // Skip if nothing changed since last tick — no point broadcasting
            // (and animating in the UI) the same numbers.
            if (this.lastSnapshot.get(bot.id) === serialized) continue;
            this.lastSnapshot.set(bot.id, serialized);
            wsBus.publish(`bot:${bot.id}`, 'tick', snapshot);
          }
          resolve();
        }
      );
    });
  }

  // ─── Fill detection poller ────────────────────────────────────────────
  private startFillPoller(): void {
    // First, find the highest existing roundtrip id so we don't replay history
    // on startup — only NEW roundtrips post-startup get broadcast as events.
    this.db.get<{ max_id: number | null }>(
      `SELECT MAX(id) as max_id FROM paired_roundtrips`,
      (err, row) => {
        if (err) {
          log.warn({ err: err.message }, 'could not seed lastBroadcastRoundtripId');
          return;
        }
        this.lastBroadcastRoundtripId = row?.max_id ?? 0;
        log.info({ from: this.lastBroadcastRoundtripId }, 'fill poller seeded');

        // Now start the periodic poll
        this.fillTimer = setInterval(() => {
          this.broadcastNewFills().catch((err) => log.error({ err }, 'fill broadcast failed'));
        }, this.fillIntervalMs);
        this.fillTimer.unref?.();
      }
    );
  }

  private broadcastNewFills(): Promise<void> {
    return new Promise((resolve) => {
      this.db.all<PairedRoundtripRow & { bot_id: number | null }>(
        `SELECT id, bot_id, buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit, created_at
         FROM paired_roundtrips
         WHERE id > ?
         ORDER BY id ASC`,
        [this.lastBroadcastRoundtripId],
        (err, rows) => {
          if (err) {
            log.error({ err: err.message }, 'fill query failed');
            return resolve();
          }
          if (!rows || rows.length === 0) return resolve();

          for (const rt of rows) {
            const fill = {
              id: rt.id,
              botId: rt.bot_id,
              buyFillId: rt.buy_fill_id,
              sellFillId: rt.sell_fill_id,
              buyPrice: rt.buy_price,
              sellPrice: rt.sell_price,
              size: rt.size,
              profit: rt.profit,
              createdAt: rt.created_at
            };
            wsBus.publish('fills', 'fill', fill);
            if (rt.bot_id) wsBus.publish(`bot:${rt.bot_id}`, 'fill', fill);
            this.lastBroadcastRoundtripId = rt.id;
          }
          log.debug({ count: rows.length, lastId: this.lastBroadcastRoundtripId }, 'broadcast new fills');
          resolve();
        }
      );
    });
  }
}
