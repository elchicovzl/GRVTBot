// G.4 + G.5 — Observability integration tests against a REAL in-memory
// GridBotDB (so migrations actually run) + the real v2 router:
//
//   - alerts table migration (columns + index, idempotent re-init)
//   - recordAlert / getAlertsForUser scoping + limit
//   - GET /api/v2/alerts auth (401) and per-user scoping (JWT vs api key)
//   - ws-dispatcher persists safeguard/margin alerts for the bot owner
//   - GET /api/v2/metrics exposes the new registry metrics + WAL gauge
//   - WAL checkpoint guard threshold math + forced checkpoint on a file DB

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GridBotDB } from '../src/database/db.js';
import { createV2Router } from '../src/server/v2-router.js';
import { WsDispatcher } from '../src/server/ws-dispatcher.js';
import { botMetrics } from '../src/server/metrics-registry.js';
import {
  startWalCheckpointGuard,
  walCheckpointThresholdBytes,
} from '../src/database/wal-checkpoint.js';
import { signToken } from '../src/auth/jwt.js';

const API_KEY = 'test-api-key-32-chars-long-xxxx';

async function makeDb(): Promise<GridBotDB> {
  const db = new GridBotDB(':memory:');
  await db.initialize();
  return db;
}

function makeApp(db: GridBotDB) {
  const router = createV2Router({
    db: db.getRawDb(),
    gridBotDb: db,
    grvtClient: {
      getInstruments: async () => [],
      getBalance: async () => ({}),
      getTicker: async () => ({ last_price: '2100' }),
      getPosition: async () => null,
      getOpenOrders: async () => [],
      getKlines: async () => [],
      getFillHistory: async () => [],
    } as any,
    engineOps: {
      createBot: async () => 1,
      startBot: async () => undefined,
      pauseBot: async () => undefined,
      closeBot: async () => undefined,
      updateBotRange: async () => undefined,
      previewBotRangeUpdate: async () => ({}),
    },
    apiKey: API_KEY,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v2', router);
  return app;
}

beforeAll(() => {
  // The metrics endpoint falls back to localhost-only when METRICS_TOKEN
  // is unset — supertest connects from 127.0.0.1, so that path is fine.
  delete process.env.METRICS_TOKEN;
});

describe('alerts table migration (G.4)', () => {
  it('creates the alerts table with all expected columns and the user/created index', async () => {
    const db = await makeDb();
    const priv = db as unknown as {
      dbAll: (sql: string, ...p: unknown[]) => Promise<Array<Record<string, unknown>>>;
    };
    const cols = (await priv.dbAll(`PRAGMA table_info(alerts)`)).map((r) => r.name);
    for (const c of ['id', 'user_id', 'bot_id', 'type', 'severity', 'message', 'created_at']) {
      expect(cols, `missing alerts column: ${c}`).toContain(c);
    }
    const indexes = (await priv.dbAll(`PRAGMA index_list(alerts)`)).map((r) => r.name);
    expect(indexes).toContain('idx_alerts_user_created');
    await db.close();
  });

  it('is idempotent — re-running initialize() does not error', async () => {
    const db = await makeDb();
    await expect(db.initialize()).resolves.not.toThrow();
    await db.close();
  });
});

describe('recordAlert + getAlertsForUser (G.4)', () => {
  it('persists alerts and scopes reads per user, newest first, with limit', async () => {
    const db = await makeDb();
    const u1 = await db.createUser({ email: 'a@x.com', password_hash: 'h' });
    const u2 = await db.createUser({ email: 'b@x.com', password_hash: 'h' });

    await db.recordAlert({ user_id: u1, bot_id: 1, type: 'safeguard', severity: 'critical', message: 'first' });
    await db.recordAlert({ user_id: u1, bot_id: 1, type: 'margin_pause', message: 'second' });
    await db.recordAlert({ user_id: u2, bot_id: 9, type: 'safeguard', severity: 'info', message: 'other user' });

    const mine = await db.getAlertsForUser(u1, 50);
    expect(mine).toHaveLength(2);
    expect(mine.map((a) => a.message)).toEqual(['second', 'first']); // DESC
    expect(mine[0]!.severity).toBe('warning'); // default
    expect(mine[1]!.severity).toBe('critical');
    expect(mine.every((a) => a.user_id === u1)).toBe(true);

    const limited = await db.getAlertsForUser(u1, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.message).toBe('second');
    await db.close();
  });

  it('rejects severities outside the CHECK constraint', async () => {
    const db = await makeDb();
    const u1 = await db.createUser({ email: 'a@x.com', password_hash: 'h' });
    await expect(
      db.recordAlert({ user_id: u1, type: 't', severity: 'apocalyptic' as never, message: 'm' })
    ).rejects.toThrow();
    await db.close();
  });
});

describe('GET /api/v2/alerts (G.4)', () => {
  it('returns 401 without credentials and with an invalid bearer', async () => {
    const db = await makeDb();
    const app = makeApp(db);
    expect((await request(app).get('/api/v2/alerts')).status).toBe(401);
    expect(
      (await request(app).get('/api/v2/alerts').set('Authorization', 'Bearer nope')).status
    ).toBe(401);
    await db.close();
  });

  it('scopes results to the authenticated user (api key = user 1, JWT = its own user)', async () => {
    const db = await makeDb();
    const app = makeApp(db);
    const u1 = await db.createUser({ email: 'a@x.com', password_hash: 'h' });
    const u2 = await db.createUser({ email: 'b@x.com', password_hash: 'h' });
    expect(u1).toBe(1);

    await db.recordAlert({ user_id: u1, bot_id: 1, type: 'safeguard', message: 'mine' });
    await db.recordAlert({ user_id: u2, bot_id: 2, type: 'safeguard', message: 'theirs' });

    // Legacy api key maps to user 1 — must NOT see user 2's alert.
    const asAdmin = await request(app).get('/api/v2/alerts').set('X-Api-Key', API_KEY);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.alerts).toHaveLength(1);
    expect(asAdmin.body.alerts[0].message).toBe('mine');

    // JWT for user 2 only sees its own.
    const asU2 = await request(app)
      .get('/api/v2/alerts')
      .set('Authorization', `Bearer ${signToken(u2)}`);
    expect(asU2.status).toBe(200);
    expect(asU2.body.alerts).toHaveLength(1);
    expect(asU2.body.alerts[0].message).toBe('theirs');
    await db.close();
  });

  it('caps ?limit and tolerates garbage values', async () => {
    const db = await makeDb();
    const app = makeApp(db);
    const u1 = await db.createUser({ email: 'a@x.com', password_hash: 'h' });
    for (let i = 0; i < 3; i++) {
      await db.recordAlert({ user_id: u1, type: 't', message: `m${i}` });
    }
    const res = await request(app)
      .get('/api/v2/alerts?limit=2')
      .set('X-Api-Key', API_KEY);
    expect(res.body.alerts).toHaveLength(2);

    const garbage = await request(app)
      .get('/api/v2/alerts?limit=banana')
      .set('X-Api-Key', API_KEY);
    expect(garbage.status).toBe(200);
    expect(garbage.body.alerts).toHaveLength(3); // falls back to 50
    await db.close();
  });
});

describe('ws-dispatcher alert persistence (G.4)', () => {
  it('persists safeguard + margin pauses for the bot OWNER (not user 1)', async () => {
    const db = await makeDb();
    const u1 = await db.createUser({ email: 'a@x.com', password_hash: 'h' });
    const u2 = await db.createUser({ email: 'b@x.com', password_hash: 'h' });
    void u1;
    // Bot 5 belongs to user 2.
    await new Promise<void>((resolve, reject) =>
      db.getRawDb().run(
        `INSERT INTO grid_bots (id, pair, direction, leverage, lower_price, upper_price,
          num_grids, investment_usdt, status, user_id)
         VALUES (5, 'ETH_USDT_Perp', 'long', 5, 1000, 2000, 10, 500, 'paused', ?)`,
        [u2],
        (err) => (err ? reject(err) : resolve())
      )
    );

    const engine = new EventEmitter();
    const dispatcher = new WsDispatcher({ engine, db: db.getRawDb(), alertStore: db });
    dispatcher.start();

    engine.emit('safeguardTriggered', {
      botId: 5,
      action: 'pause',
      reason: 'SAFEGUARD:pause:bot=5:dist=1.0%:liq=990:mark=1001',
      error: 'SAFEGUARD:pause:bot=5:dist=1.0%:liq=990:mark=1001',
    });
    engine.emit('safeguardTriggered', {
      botId: 5,
      action: 'pause',
      reason: 'MARGIN:pause:bot=5:headroom=0.01',
      error: 'MARGIN:pause:bot=5:headroom=0.01',
    });
    engine.emit('botCloseFailed', {
      botId: 5,
      residualSize: 0.05,
      pair: 'ETH_USDT_Perp',
      closeOrderId: null,
      reason: 'close order not filled in time',
    });
    // F2.2: backfill reconciliation found live position ≠ grid-implied.
    engine.emit('positionDrift', {
      botId: 5,
      pair: 'ETH_USDT_Perp',
      liveSize: 0.1,
      expectedSize: 0.25,
      drift: 0.15,
      tolerance: 0.025,
    });

    // persistAlert resolves the owner via an async db.get — give it a beat.
    await new Promise((r) => setTimeout(r, 100));
    dispatcher.stop();

    const alerts = await db.getAlertsForUser(u2, 50);
    expect(alerts).toHaveLength(4);
    const types = alerts.map((a) => a.type).sort();
    expect(types).toEqual(['close_failed', 'margin_pause', 'position_drift', 'safeguard']);
    expect(alerts.every((a) => a.bot_id === 5)).toBe(true);
    expect(alerts.every((a) => a.severity === 'critical')).toBe(true);
    const driftAlert = alerts.find((a) => a.type === 'position_drift')!;
    expect(driftAlert.message).toContain('live 0.1');
    expect(driftAlert.message).toContain('Not auto-corrected');

    // Nothing leaked to user 1.
    expect(await db.getAlertsForUser(1, 50)).toHaveLength(0);
    await db.close();
  });
});

describe('GET /api/v2/metrics (G.5)', () => {
  beforeEach(() => botMetrics.reset());

  it('exposes per-bot tick/stall/error metrics and the WAL size gauge', async () => {
    const db = await makeDb();
    const app = makeApp(db);

    botMetrics.recordTick(7, 'ETH_USDT_Perp', 123);
    botMetrics.recordTick(8, 'BTC_USDT_Perp', 12_000); // stall
    botMetrics.recordError(7, 'safeguard');
    botMetrics.recordError(7, 'api_timeout');

    const res = await request(app).get('/api/v2/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body: string = res.text;
    expect(body).toContain('grvt_bot_tick_duration_ms{bot_id="7",pair="ETH_USDT_Perp"} 123');
    expect(body).toContain('grvt_bot_tick_duration_ms{bot_id="8",pair="BTC_USDT_Perp"} 12000');
    expect(body).toContain('grvt_bot_tick_stalls_total 1');
    expect(body).toContain('grvt_bot_errors_total{bot_id="7",error_type="safeguard"} 1');
    expect(body).toContain('grvt_bot_errors_total{bot_id="7",error_type="api_timeout"} 1');
    // WAL gauge present even for :memory: (0 — no -wal file).
    expect(body).toContain('grvt_sqlite_wal_size_bytes 0');
    // Pre-existing metrics still there (no regression).
    expect(body).toContain('grvt_process_uptime_seconds');
    await db.close();
  });
});

describe('WAL checkpoint guard (G.5)', () => {
  const ORIGINAL_ENV = process.env.GRVT_WAL_CHECKPOINT_MB;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grvt-wal-test-'));
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.GRVT_WAL_CHECKPOINT_MB;
    else process.env.GRVT_WAL_CHECKPOINT_MB = ORIGINAL_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to 100MB and honors GRVT_WAL_CHECKPOINT_MB', () => {
    delete process.env.GRVT_WAL_CHECKPOINT_MB;
    expect(walCheckpointThresholdBytes()).toBe(100 * 1024 * 1024);
    process.env.GRVT_WAL_CHECKPOINT_MB = '250';
    expect(walCheckpointThresholdBytes()).toBe(250 * 1024 * 1024);
    process.env.GRVT_WAL_CHECKPOINT_MB = 'garbage';
    expect(walCheckpointThresholdBytes()).toBe(100 * 1024 * 1024);
  });

  it('checkpoints a real file-backed WAL when it exceeds the threshold', async () => {
    const dbPath = path.join(tmpDir, 'wal-guard.db');
    const db = new GridBotDB(dbPath);
    await db.initialize(); // WAL mode + migrations → the -wal file grows

    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    // Tiny threshold (~105 bytes) so the migration WAL already exceeds it.
    process.env.GRVT_WAL_CHECKPOINT_MB = '0.0001';
    const guard = startWalCheckpointGuard(db, { intervalMs: 60_000 });
    const result = await guard.checkNow();
    guard.stop();

    expect(result.checkpointed).toBe(true);
    expect(result.walBytes).toBeGreaterThan(walCheckpointThresholdBytes());
    await db.close();
  });

  it('does nothing below the threshold', async () => {
    const dbPath = path.join(tmpDir, 'wal-guard-quiet.db');
    const db = new GridBotDB(dbPath);
    await db.initialize();

    process.env.GRVT_WAL_CHECKPOINT_MB = '100';
    const guard = startWalCheckpointGuard(db, { intervalMs: 60_000 });
    const result = await guard.checkNow();
    guard.stop();

    expect(result.checkpointed).toBe(false);
    await db.close();
  });
});
