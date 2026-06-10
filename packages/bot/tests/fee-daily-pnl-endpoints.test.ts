// F4.4 — fee-summary + daily-pnl + APR endpoint tests.
//
// Unlike api-endpoints.test.ts (which fakes the sqlite3 callback shape),
// these endpoints' correctness IS the SQL aggregation — so we run them
// against a REAL in-memory SQLite via GridBotDB.initialize() (full schema
// + migrations) and seed fixture rows. Auth/ownership is exercised with
// real JWTs (JWT_SECRET is set in tests/setup.ts).

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'sqlite3';
import { createV2Router } from '../src/server/v2-router.js';
import { GridBotDB } from '../src/database/db.js';
import { signToken } from '../src/auth/jwt.js';

const API_KEY = 'test-api-key-32-chars-long-xxxx';

function makeMockGrvtClient() {
  return {
    getInstruments: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ total_equity: '10000' }),
    getTicker: vi.fn().mockResolvedValue({ last_price: '2100' }),
    getPosition: vi.fn().mockResolvedValue(null),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getFillHistory: vi.fn().mockResolvedValue([]),
  };
}

function makeMockEngineOps() {
  return {
    createBot: vi.fn().mockResolvedValue(42),
    startBot: vi.fn().mockResolvedValue(undefined),
    pauseBot: vi.fn().mockResolvedValue(undefined),
    closeBot: vi.fn().mockResolvedValue(undefined),
    updateBotRange: vi.fn().mockResolvedValue(undefined),
    previewBotRangeUpdate: vi.fn().mockResolvedValue({}),
    rebindGrvtClient: vi.fn().mockResolvedValue(undefined),
  };
}

interface TestCtx {
  app: express.Express;
  gridBotDb: GridBotDB;
  run: (sql: string, params?: unknown[]) => Promise<void>;
}

async function createRealDbApp(): Promise<TestCtx> {
  const gridBotDb = new GridBotDB(':memory:');
  await gridBotDb.initialize();
  // The router takes the raw sqlite3 handle; GridBotDB keeps it private,
  // so reach in via reflection (same trade-off db-migrations.test.ts makes).
  const raw = (gridBotDb as unknown as { db: Database.Database }).db;

  const router = createV2Router({
    db: raw,
    gridBotDb: gridBotDb as any,
    grvtClient: makeMockGrvtClient() as any,
    engineOps: makeMockEngineOps(),
    apiKey: API_KEY,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v2', router);

  const run = (sql: string, params: unknown[] = []) =>
    new Promise<void>((resolve, reject) => {
      raw.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });

  return { app, gridBotDb, run };
}

// Seed a bot row owned by `userId`. created_at is set via SQLite datetime
// offsets so days_active is deterministic enough for toBeCloseTo.
async function seedBot(
  ctx: TestCtx,
  opts: {
    id: number;
    userId: number;
    createdDaysAgo?: number;
    investment?: number;
    originalInvestment?: number | null;
    gridProfit?: number;
    trendPnl?: number;
  }
): Promise<void> {
  await ctx.run(
    `INSERT INTO grid_bots
       (id, user_id, pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, original_investment_usdt,
        grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt, status, created_at)
     VALUES (?, ?, 'ETH_USDT_Perp', 'long', 2, 1800, 2400, 10, ?, ?, ?, ?, 0,
             'running', datetime('now', ?))`,
    [
      opts.id,
      opts.userId,
      opts.investment ?? 1000,
      opts.originalInvestment === undefined ? 1000 : opts.originalInvestment,
      opts.gridProfit ?? 0,
      opts.trendPnl ?? 0,
      `-${opts.createdDaysAgo ?? 10} days`,
    ]
  );
}

// ── GET /bots/:id/fee-summary ─────────────────────────────────────────

describe('GET /api/v2/bots/:id/fee-summary', () => {
  it('rejects unauthenticated requests', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const res = await request(ctx.app).get('/api/v2/bots/1/fee-summary');
    expect(res.status).toBe(401);
  });

  it("rejects another user's bot with 403", async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const res = await request(ctx.app)
      .get('/api/v2/bots/1/fee-summary')
      .set('Authorization', `Bearer ${signToken(2)}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown bot', async () => {
    const ctx = await createRealDbApp();
    const res = await request(ctx.app)
      .get('/api/v2/bots/999/fee-summary')
      .set('X-Api-Key', API_KEY);
    expect(res.status).toBe(404);
  });

  it('computes the maker/taker/rebate split from signed fees', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });

    // Signed fees: positive = paid (taker), negative = maker rebate.
    const fills: Array<[string, number, number]> = [
      ['f1', 1, 0.5],   // taker fee paid
      ['f2', 0, 0.3],   // taker fee paid
      ['f3', 1, -0.2],  // maker rebate
      ['f4', 0, -0.1],  // maker rebate
    ];
    for (const [fillId, isBuyer, fee] of fills) {
      await ctx.run(
        `INSERT INTO fills_archive (fill_id, event_time, is_buyer, price, size, fee, created_at, bot_id, instrument)
         VALUES (?, ?, ?, 2000, 0.05, ?, datetime('now'), 1, 'ETH_USDT_Perp')`,
        [fillId, fillId, isBuyer, fee]
      );
    }
    // Gross grid profit: 2 roundtrips of $5 each.
    for (const [buyId, sellId, profit] of [['f2', 'f1', 5], ['f4', 'f3', 5]] as const) {
      await ctx.run(
        `INSERT INTO paired_roundtrips (buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit, created_at, bot_id)
         VALUES (?, ?, 2000, 2100, 0.05, ?, datetime('now'), 1)`,
        [buyId, sellId, profit]
      );
    }

    const res = await request(ctx.app)
      .get('/api/v2/bots/1/fee-summary')
      .set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.total_fees_usdt).toBeCloseTo(0.5, 9);   // 0.8 - 0.3
    expect(res.body.taker_fees_usdt).toBeCloseTo(0.8, 9);   // 0.5 + 0.3
    expect(res.body.maker_fees_usdt).toBeCloseTo(-0.3, 9);  // -0.2 - 0.1 (signed)
    expect(res.body.rebates_usdt).toBeCloseTo(0.3, 9);
    // fee % of gross: 0.5 / 10 * 100 = 5%
    expect(res.body.fee_pct_of_gross_profit).toBeCloseTo(5, 9);
    expect(res.body.roundtrips_count).toBe(2);
    expect(res.body.gross_profit_usdt).toBeCloseTo(10, 9);
    expect(res.body.fill_count).toBe(4);
  });

  it('returns zeros and a null fee % when there is no activity yet', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const res = await request(ctx.app)
      .get('/api/v2/bots/1/fee-summary')
      .set('X-Api-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.total_fees_usdt).toBe(0);
    expect(res.body.taker_fees_usdt).toBe(0);
    expect(res.body.maker_fees_usdt).toBe(0);
    expect(res.body.rebates_usdt).toBe(0);
    expect(res.body.fee_pct_of_gross_profit).toBeNull();
    expect(res.body.roundtrips_count).toBe(0);
  });

  it("does not leak another bot's fills into the aggregate", async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    await seedBot(ctx, { id: 2, userId: 1 });
    await ctx.run(
      `INSERT INTO fills_archive (fill_id, event_time, is_buyer, price, size, fee, created_at, bot_id, instrument)
       VALUES ('mine', 'mine', 1, 2000, 0.05, 1.0, datetime('now'), 1, 'ETH_USDT_Perp')`
    );
    await ctx.run(
      `INSERT INTO fills_archive (fill_id, event_time, is_buyer, price, size, fee, created_at, bot_id, instrument)
       VALUES ('other', 'other', 1, 2000, 0.05, 99.0, datetime('now'), 2, 'ETH_USDT_Perp')`
    );
    const res = await request(ctx.app)
      .get('/api/v2/bots/1/fee-summary')
      .set('X-Api-Key', API_KEY);
    expect(res.body.total_fees_usdt).toBeCloseTo(1.0, 9);
    expect(res.body.fill_count).toBe(1);
  });
});

// ── GET /bots/:id/daily-pnl ───────────────────────────────────────────

describe('GET /api/v2/bots/:id/daily-pnl', () => {
  async function seedSnapshot(
    ctx: TestCtx,
    botId: number,
    date: string,
    cumulative: { grid: number; trend: number; total: number; equity: number; rt: number }
  ) {
    await ctx.run(
      `INSERT INTO daily_snapshots (bot_id, date, equity, grid_profit_net, trend_pnl, total_pnl, round_trips)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [botId, date, cumulative.equity, cumulative.grid, cumulative.trend, cumulative.total, cumulative.rt]
    );
  }

  it('rejects unauthenticated requests', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const res = await request(ctx.app).get('/api/v2/bots/1/daily-pnl');
    expect(res.status).toBe(401);
  });

  it("rejects another user's bot with 403", async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const res = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl')
      .set('Authorization', `Bearer ${signToken(2)}`);
    expect(res.status).toBe(403);
  });

  it('computes per-day deltas from cumulative snapshots (incl. funding residual)', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });

    // Cumulative series. total = grid + trend + funding, so the funding
    // residual per day is recoverable from the deltas.
    await seedSnapshot(ctx, 1, '2026-06-01', { grid: 10, trend: 2, total: 12.5, equity: 1012.5, rt: 5 });
    await seedSnapshot(ctx, 1, '2026-06-02', { grid: 14, trend: 1, total: 15.8, equity: 1015.8, rt: 8 });
    await seedSnapshot(ctx, 1, '2026-06-03', { grid: 20, trend: -3, total: 17.0, equity: 1017.0, rt: 12 });

    const res = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl?days=2')
      .set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(2);
    expect(res.body.points).toHaveLength(2);

    const [d2, d3] = res.body.points;
    // 06-02 diffs against 06-01 (baseline row outside the window)
    expect(d2.date).toBe('2026-06-02');
    expect(d2.grid_profit_delta).toBeCloseTo(4, 9);
    expect(d2.trend_pnl_delta).toBeCloseTo(-1, 9);
    expect(d2.total_pnl_delta).toBeCloseTo(3.3, 9);
    expect(d2.funding_delta).toBeCloseTo(3.3 - 4 + 1, 9); // 0.3
    expect(d2.round_trips).toBe(3);
    expect(d2.equity).toBeCloseTo(1015.8, 9);

    expect(d3.date).toBe('2026-06-03');
    expect(d3.grid_profit_delta).toBeCloseTo(6, 9);
    expect(d3.trend_pnl_delta).toBeCloseTo(-4, 9);
    expect(d3.total_pnl_delta).toBeCloseTo(1.2, 9);
    expect(d3.funding_delta).toBeCloseTo(1.2 - 6 + 4, 9); // -0.8
    expect(d3.round_trips).toBe(4);
  });

  it('treats the first-ever snapshot as a delta from zero (no baseline row)', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    await seedSnapshot(ctx, 1, '2026-06-01', { grid: 7, trend: 1, total: 8.5, equity: 1008.5, rt: 4 });

    const res = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl?days=30')
      .set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(1);
    const [p] = res.body.points;
    expect(p.grid_profit_delta).toBeCloseTo(7, 9);
    expect(p.trend_pnl_delta).toBeCloseTo(1, 9);
    expect(p.total_pnl_delta).toBeCloseTo(8.5, 9);
    expect(p.funding_delta).toBeCloseTo(0.5, 9);
    expect(p.round_trips).toBe(4);
  });

  it('clamps days to [1, 365] and defaults to 30', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const def = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl')
      .set('X-Api-Key', API_KEY);
    expect(def.body.days).toBe(30);
    const over = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl?days=9999')
      .set('X-Api-Key', API_KEY);
    expect(over.body.days).toBe(365);
    const under = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl?days=0')
      .set('X-Api-Key', API_KEY);
    expect(under.body.days).toBe(1);
  });

  it('returns an empty points array when the bot has no snapshots', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    const res = await request(ctx.app)
      .get('/api/v2/bots/1/daily-pnl')
      .set('X-Api-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
  });
});

// ── APR augmentation on GET /bots and GET /bots/:id ──────────────────

describe('APR fields on bot endpoints', () => {
  it('computes apr_pct = (pnl / original_investment) / (days/365) * 100', async () => {
    const ctx = await createRealDbApp();
    // 365 days active, original investment 1000, grid 50 + trend 10 = 60
    // → APR = (60/1000) / (365/365) * 100 = 6%
    await seedBot(ctx, {
      id: 1,
      userId: 1,
      createdDaysAgo: 365,
      investment: 1200, // bumped by compound — APR must use ORIGINAL
      originalInvestment: 1000,
      gridProfit: 50,
      trendPnl: 10,
    });

    const res = await request(ctx.app)
      .get('/api/v2/bots')
      .set('X-Api-Key', API_KEY);
    expect(res.status).toBe(200);
    const bot = res.body.bots.find((b: { id: number }) => b.id === 1);
    expect(bot.days_active).toBeCloseTo(365, 1);
    expect(bot.apr_pct).toBeCloseTo(6, 1);
  });

  it('includes net funding in the APR PnL', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, {
      id: 1,
      userId: 1,
      createdDaysAgo: 365,
      originalInvestment: 1000,
      gridProfit: 50,
      trendPnl: 10,
    });
    // Net funding = carried + (latest - baseline) = 1 + (4 - 0) = +5
    await ctx.run(
      `INSERT INTO funding_snapshots (bot_id, instrument, baseline_cumulative, latest_cumulative, carried_net, latest_funding_time)
       VALUES (1, 'ETH_USDT_Perp', 0, 4, 1, datetime('now'))`
    );
    const res = await request(ctx.app)
      .get('/api/v2/bots/1')
      .set('X-Api-Key', API_KEY);
    expect(res.status).toBe(200);
    // (65/1000) / 1 * 100 = 6.5%
    expect(res.body.bot.apr_pct).toBeCloseTo(6.5, 1);
  });

  it('returns apr_pct = null for bots active less than 1 day', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, {
      id: 1,
      userId: 1,
      createdDaysAgo: 0, // just created
      originalInvestment: 1000,
      gridProfit: 5,
    });
    const res = await request(ctx.app)
      .get('/api/v2/bots/1')
      .set('X-Api-Key', API_KEY);
    expect(res.body.bot.apr_pct).toBeNull();
    expect(res.body.bot.days_active).toBeCloseTo(0, 1);
  });

  it('falls back to investment_usdt when original_investment is NULL (legacy rows)', async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, {
      id: 1,
      userId: 1,
      createdDaysAgo: 365,
      investment: 500,
      originalInvestment: null,
      gridProfit: 25, // 25/500 = 5% over exactly one year
    });
    const res = await request(ctx.app)
      .get('/api/v2/bots/1')
      .set('X-Api-Key', API_KEY);
    expect(res.body.bot.apr_pct).toBeCloseTo(5, 1);
  });

  it("does not expose another user's bot in the list", async () => {
    const ctx = await createRealDbApp();
    await seedBot(ctx, { id: 1, userId: 1 });
    await seedBot(ctx, { id: 2, userId: 7 });
    const res = await request(ctx.app)
      .get('/api/v2/bots')
      .set('X-Api-Key', API_KEY); // legacy key = user 1
    const ids = res.body.bots.map((b: { id: number }) => b.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });
});
