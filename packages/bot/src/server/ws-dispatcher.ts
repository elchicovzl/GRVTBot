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

export interface DispatcherDeps {
  /** The GridEngine instance (or anything with .on(eventName, fn) — we type loosely to avoid pulling the giant grid-engine types in here). */
  engine: EventEmitter;
  /** A sqlite3 Database that has both `grid_bots` and `paired_roundtrips` tables. */
  db: Database.Database;
  /** Polling interval for the per-bot state tick. Default 1000ms. */
  tickIntervalMs?: number;
  /** Polling interval for the fill detector. Default 2000ms. */
  fillIntervalMs?: number;
}

export class WsDispatcher {
  private engine: EventEmitter;
  private db: Database.Database;
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
    this.tickIntervalMs = deps.tickIntervalMs ?? 1000;
    this.fillIntervalMs = deps.fillIntervalMs ?? 2000;
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
      wsBus.publishToMany(
        [`bot:${payload.botId}`, 'bots', 'notifications'],
        'botCloseFailed',
        payload
      );
    });

    this.engine.on('safeguardTriggered', (payload: { botId: number; error: string }) => {
      log.warn({ ...payload }, 'safeguard triggered');
      wsBus.publishToMany(
        [`bot:${payload.botId}`, 'bots', 'notifications'],
        'safeguardTriggered',
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
