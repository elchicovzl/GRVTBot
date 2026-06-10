// F2.2 — Fill backfill + position reconciliation on reconnect/restart.
//
// Live fill detection relies on (a) REST getFillHistory with a ~90s
// lookback and (b) the WS-backed fills_archive that only captures fills
// while connected. A fill that lands inside a connectivity gap (or while
// the process is down) is invisible to both: the level never flips, the
// counter-order is never placed, the position accumulates unhedged.
//
// These tests drive the REAL engine paths (backfillFills, monitorAllBots
// gap trigger, loadActiveBots resume) against the same FakeGrvtClient /
// FakeDb pattern as grid-engine-integration.test.ts, extended with:
//   - getFillHistory(limit, pair, endTimeNs) pagination (newest→oldest,
//     end_time inclusive upper bound — mirrors the real GRVT cursor),
//   - insertFillArchive (idempotent on fill_id, like INSERT OR IGNORE),
//   - getLatestFillEventTimeForBot (the backfill watermark).
//
// Scenarios:
//   1. 5-minute gap → backfill recovers the fill, flips the level, places
//      the counter-order through the SAME pipeline the monitor uses.
//   2. Restart with a fill that happened while down → resume triggers
//      backfill and restores grid coherence.
//   3. Idempotency: archive insert + processedFills dedup hold.
//   4. Live position ≠ grid-implied → 'position_drift' emitted, NO
//      corrective orders, bot keeps running.
//   5. No gap → backfill is a cheap no-op (one page, no orders, no alert).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Module mocks (same holder/proxy pattern as the integration suite) ─

const { clientHolder, dbHolder, singletonClientProxy, dbProxy } = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  delete process.env.DRY_RUN;

  const clientHolder: { current: any } = { current: null };
  const dbHolder: { current: any } = { current: null };

  const makeDelegate = (holder: { current: any }, label: string) =>
    new Proxy({}, {
      get(_t, prop) {
        const target = holder.current;
        if (!target) throw new Error(`${label}.${String(prop)} accessed before test setup`);
        const v = target[prop as any];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

  return {
    clientHolder,
    dbHolder,
    singletonClientProxy: makeDelegate(clientHolder, 'grvtClient'),
    dbProxy: makeDelegate(dbHolder, 'db'),
  };
});

vi.mock('../src/api/client.js', () => ({
  grvtClient: singletonClientProxy,
  GRVTClient: vi.fn(),
  getInstrumentSpec: () => ({ min_size: 0.01, min_notional: 1 }),
}));

vi.mock('../src/api/grvt-client-factory.js', () => ({
  getGrvtClientForBot: vi.fn(async () => {
    throw new Error('factory should not be used in this suite');
  }),
  invalidateGrvtClient: vi.fn(),
}));

vi.mock('../src/database/db.js', () => ({
  db: dbProxy,
}));

import { GridEngine, GridBotInstance } from '../src/bot/grid-engine.js';

// ── Fakes ────────────────────────────────────────────────────────────

interface FakeOpenOrder {
  order_id: string;
  legs: Array<{ limit_price: string; is_buying_asset: boolean }>;
  metadata?: { client_order_id?: string };
}

class FakeGrvtClient {
  price = 2000;
  openOrders: FakeOpenOrder[] = [];
  /** REST fill history, any order — getFillHistory sorts newest→oldest. */
  fills: any[] = [];
  totalEquity = 1_000_000;
  marginUsed = 0;
  positions: Array<{ instrument: string; size: string; unrealized_pnl: string; entry_price: string }> = [];
  createOrderErrors: Array<Error | null> = [];
  openOrdersError: Error | null = null;
  /** Max fills returned per getFillHistory page (forces pagination when small). */
  pageSize = 1000;

  orderSeq = 0;
  calls = {
    createOrder: [] as any[],
    cancelOrder: [] as string[],
    cancelAllOrders: 0,
    getTicker: 0,
    getFillHistory: 0,
  };

  get subAccountId(): string {
    return 'fake-sub-account';
  }

  async getTicker(_pair: string) {
    this.calls.getTicker++;
    return { last_price: String(this.price) };
  }

  async getOpenOrders(_pair?: string) {
    if (this.openOrdersError) throw this.openOrdersError;
    return [...this.openOrders];
  }

  /**
   * GRVT cursor semantics: returns fills newest→oldest; `endTimeNs` is an
   * INCLUSIVE upper bound on event_time (callers page with oldest-1ns).
   * Like the real endpoint, the `instrument` filter is IGNORED — the
   * engine must filter client-side.
   */
  async getFillHistory(limit: number, _pair?: string, endTimeNs?: string) {
    this.calls.getFillHistory++;
    let result = [...this.fills];
    if (endTimeNs) {
      result = result.filter((f) => BigInt(f.event_time) <= BigInt(endTimeNs));
    }
    result.sort((a, b) => (BigInt(a.event_time) > BigInt(b.event_time) ? -1 : 1));
    return result.slice(0, Math.min(limit, this.pageSize));
  }

  async getPosition(pair: string) {
    return this.positions.find((p) => p.instrument === pair) ?? null;
  }

  async getPositions() {
    return [...this.positions];
  }

  /** Resume path: GRVT only exposes applied leverage with a position; null is the common case. */
  async getAppliedLeverage(_pair: string) {
    return null;
  }

  async getBalance() {
    return {
      total_equity: String(this.totalEquity),
      margin_used: String(this.marginUsed),
      available_balance: String(this.totalEquity - this.marginUsed),
    };
  }

  async createOrder(params: any, _skipBalanceCheck?: boolean) {
    this.calls.createOrder.push({ ...params });
    const err = this.createOrderErrors.shift();
    if (err) throw err;
    const order_id = `ord_${++this.orderSeq}`;

    const px = parseFloat(params.price);
    const crosses = params.side === 'sell' ? px <= this.price : px >= this.price;
    if (!params.post_only && crosses) {
      const pos = this.positions.find((p) => p.instrument === params.instrument);
      if (pos) {
        const delta = parseFloat(params.size) * (params.side === 'sell' ? -1 : 1);
        const newSize = parseFloat(pos.size) + delta;
        if (Math.abs(newSize) < 1e-9 || (params.reduce_only && parseFloat(pos.size) * newSize <= 0)) {
          this.positions = this.positions.filter((p) => p !== pos);
        } else {
          pos.size = String(newSize);
        }
      }
      return { order_id, metadata: params.metadata };
    }

    this.openOrders.push({
      order_id,
      legs: [{ limit_price: String(params.price), is_buying_asset: params.side === 'buy' }],
      metadata: { client_order_id: params.metadata },
    });
    return { order_id, metadata: params.metadata };
  }

  async cancelOrder(orderId: string, _pair?: string) {
    this.calls.cancelOrder.push(orderId);
    this.openOrders = this.openOrders.filter((o) => o.order_id !== orderId);
    return true;
  }

  async cancelAllOrders(_pair?: string) {
    this.calls.cancelAllOrders++;
    const n = this.openOrders.length;
    this.openOrders = [];
    return n;
  }

  async setLeverage(_pair: string, _lev: number) {}
  async getInstruments() { return []; }

  coverLevel(level: { price: number; side: string }): string {
    const order_id = `seed_${++this.orderSeq}`;
    this.openOrders.push({
      order_id,
      legs: [{ limit_price: String(level.price), is_buying_asset: level.side === 'buy' }],
    });
    return order_id;
  }

  ordersAtPrice(price: number): FakeOpenOrder[] {
    return this.openOrders.filter(
      (o) => Math.abs(parseFloat(o.legs[0]!.limit_price) - price) < 0.001
    );
  }
}

class FakeDb {
  bots = new Map<number, any>();
  levels: any[] = [];
  orders: any[] = [];
  trades: any[] = [];
  /** fills_archive rows. fill_id is the idempotency key (INSERT OR IGNORE). */
  archiveFills: any[] = [];
  updateBotCalls: Array<{ id: number; updates: any }> = [];
  private nextLevelId = 1;

  addBot(bot: any) { this.bots.set(bot.id, { ...bot }); }

  addLevel(l: any) {
    const row = { id: this.nextLevelId++, created_at: new Date().toISOString(), ...l };
    this.levels.push(row);
    return row;
  }

  levelAt(botId: number, levelIndex: number) {
    return this.levels.find((l) => l.bot_id === botId && l.level_index === levelIndex);
  }

  // ── engine-facing API ──
  async getBot(id: number) { const b = this.bots.get(id); return b ? { ...b } : null; }

  async updateBot(id: number, updates: any) {
    this.updateBotCalls.push({ id, updates: { ...updates } });
    const b = this.bots.get(id);
    if (b) Object.assign(b, updates);
  }

  async getAllBots() { return [...this.bots.values()].map((b) => ({ ...b })); }
  async getBotsByStatus(status: string) {
    return [...this.bots.values()].filter((b) => b.status === status).map((b) => ({ ...b }));
  }

  async getGridLevels(botId: number) {
    return this.levels
      .filter((l) => l.bot_id === botId)
      .sort((a, b) => a.level_index - b.level_index)
      .map((l) => ({ ...l }));
  }

  async updateGridLevel(id: number, updates: any) {
    const l = this.levels.find((x) => x.id === id);
    if (l) Object.assign(l, updates);
  }

  async fillGridLevel(id: number, orderId: string) {
    const l = this.levels.find((x) => x.id === id);
    if (l) Object.assign(l, { is_filled: true, order_id: orderId, filled_at: new Date().toISOString() });
  }

  async markLevelPendingReplace(id: number) {
    const l = this.levels.find((x) => x.id === id);
    if (l) l.pending_replace = true;
  }

  async clearLevelPendingReplace(id: number) {
    const l = this.levels.find((x) => x.id === id);
    if (l) l.pending_replace = false;
  }

  async getPendingReplaceGridLevels(botId: number) {
    return this.levels
      .filter((l) => l.bot_id === botId && l.pending_replace)
      .map((l) => ({ ...l }));
  }

  async createOrder(rec: any) { this.orders.push({ ...rec }); return this.orders.length; }
  async updateOrderStatus(_orderId: string, _status: string) {}
  async createTrade(t: any) { this.trades.push({ ...t }); return this.trades.length; }

  async findRecentFillsForBot(botId: number, withinMs: number) {
    const cutoffNs = (Date.now() - withinMs) * 1_000_000;
    return this.archiveFills
      .filter((f) => f.bot_id === botId && Number(f.event_time) > cutoffNs)
      .map((f) => ({ ...f }));
  }

  async getFillsForBot(botId: number) {
    return this.archiveFills.filter((f) => f.bot_id === botId).map((f) => ({ ...f }));
  }

  // ── backfill surface (F2.2) ──
  /** Mirrors INSERT OR IGNORE on the UNIQUE fill_id: true only when NEW. */
  async insertFillArchive(p: any) {
    if (this.archiveFills.some((f) => f.fill_id === p.fill_id)) return false;
    this.archiveFills.push({ ...p });
    return true;
  }

  async getLatestFillEventTimeForBot(botId: number) {
    const rows = this.archiveFills.filter((f) => f.bot_id === botId);
    if (rows.length === 0) return null;
    return rows
      .map((f) => BigInt(f.event_time))
      .reduce((a, b) => (a > b ? a : b))
      .toString();
  }

  async sumPairedRoundtripProfit(_botId: number) { return 0; }
  async sumFeesForBot(_botId: number) { return 0; }
  async insertPairedRoundtrip(_p: any) {}
  async getNetFundingForBot(_botId: number) { return 0; }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const PAIR = 'ETH_USDT_Perp';

// Grid: 1900..2100, 10 grids → 11 levels every $20 (idx i = 1900 + 20i).
function makeBot(overrides: Record<string, any> = {}): any {
  return {
    id: 1,
    user_id: undefined,
    pair: PAIR,
    direction: 'long',
    leverage: 5,
    lower_price: 1900,
    upper_price: 2100,
    num_grids: 10,
    investment_usdt: 1000,
    grid_profit_usdt: 0,
    trend_pnl_usdt: 0,
    total_pnl_usdt: 0,
    status: 'running',
    position_size: 0,
    avg_entry_price: 0,
    liquidation_price: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    params_json: '{}',
    quantity_per_level: 0.05,
    ...overrides,
  };
}

function seedGrid(db: FakeDb, bot: any, refPrice: number): any[] {
  const spacing = (bot.upper_price - bot.lower_price) / bot.num_grids;
  const rows: any[] = [];
  for (let i = 0; i <= bot.num_grids; i++) {
    const price = Math.round((bot.lower_price + i * spacing) * 100) / 100;
    rows.push(db.addLevel({
      bot_id: bot.id,
      level_index: i,
      price,
      side: price < refPrice ? 'buy' : 'sell',
      quantity: bot.quantity_per_level,
      is_filled: false,
      order_id: null,
      state: 'active',
    }));
  }
  return rows;
}

function coverGrid(client: FakeGrvtClient, db: FakeDb, botId: number, exceptIdx: number[] = []): void {
  for (const level of db.levels.filter((l) => l.bot_id === botId)) {
    if (exceptIdx.includes(level.level_index)) continue;
    if (level.state === 'virtual') continue;
    const orderId = client.coverLevel(level);
    level.order_id = orderId;
  }
}

/** REST-shaped fill. `agoMs` puts event_time that far in the past. */
function restFill(over: Record<string, any> = {}, agoMs = 0): any {
  return {
    fill_id: 'F1',
    order_id: 'seed_x',
    client_order_id: 'c1',
    instrument: PAIR,
    price: '1980',
    size: '0.05',
    fee: '0.01',
    fee_currency: 'USDT',
    is_buyer: true,
    event_time: String((Date.now() - agoMs) * 1_000_000),
    ...over,
  };
}

interface World {
  db: FakeDb;
  client: FakeGrvtClient;
}

function setupWorld(): World {
  const db = new FakeDb();
  const client = new FakeGrvtClient();
  dbHolder.current = db;
  clientHolder.current = client;
  return { db, client };
}

function makeEngine(instances: Array<[number, GridBotInstance]>): GridEngine {
  const engine = new GridEngine();
  (engine as any).isRunning = true;
  for (const [id, inst] of instances) (engine as any).bots.set(id, inst);
  return engine;
}

/**
 * Standard downtime scenario: price 2008, idx 5 ($2000) is the natural
 * gap, the buy at idx 4 ($1980) FILLED while the bot was offline —
 * its order is gone from GRVT and the fill is too old (>90s) for the
 * monitor's live REST/archive checks. Live position already includes
 * the missed buy: 5 resting sells (idx 6-10) × 0.05 + the 0.05 bought
 * = 0.30 — exactly what the grid implies AFTER the level flips.
 */
function downtimeWorld(fillAgoMs = 5 * 60 * 1000) {
  const { db, client } = setupWorld();
  const bot = makeBot();
  db.addBot(bot);
  seedGrid(db, bot, 2008);
  client.price = 2008;
  coverGrid(client, db, bot.id, [5, 4]);
  client.fills = [restFill({ fill_id: 'F1', price: '1980', is_buyer: true }, fillAgoMs)];
  client.positions = [
    { instrument: PAIR, size: '0.30', unrealized_pnl: '0', entry_price: '1990' },
  ];
  const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
  return { db, client, instance, bot };
}

beforeEach(() => {
  dbHolder.current = null;
  clientHolder.current = null;
});

// ── 1. Connectivity gap → backfill before the next tick ──────────────

describe('monitorAllBots(): gap-triggered backfill', () => {
  it('recovers a fill missed during a 5-minute gap: level flips, counter-order placed, no drift alert', async () => {
    const { db, client, instance } = downtimeWorld();
    const engine = makeEngine([[1, instance]]);
    const driftEvents: any[] = [];
    engine.on('positionDrift', (e) => driftEvents.push(e));

    // Simulate the gap: last successful tick was 5 minutes ago (>90s).
    (engine as any).lastMonitorSuccess.set(1, Date.now() - 5 * 60 * 1000);

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // The missed fill was archived (idempotent insert, attributed to bot 1).
    expect(db.archiveFills).toHaveLength(1);
    expect(db.archiveFills[0]).toMatchObject({ bot_id: 1, price: 1980, is_buyer: 1 });

    // The level flipped through the SAME pipeline as live detection:
    // idx 4 (the filled buy) is now the gap, idx 5 carries the counter SELL.
    expect(db.levelAt(1, 4).is_filled).toBe(true);
    expect(db.levelAt(1, 4).state).toBe('filled');
    expect(db.levelAt(1, 5).side).toBe('sell');
    expect(db.levelAt(1, 5).is_filled).toBe(false);
    expect(db.levelAt(1, 5).state).toBe('active');

    // Exactly ONE order ever sent: the counter sell at $2000. No re-place
    // of $1980 over the missed fill (the pre-fix failure mode), no "fix"
    // trades for the position.
    expect(client.calls.createOrder).toHaveLength(1);
    expect(client.calls.createOrder[0]).toMatchObject({ price: '2000', side: 'sell', size: '0.05' });
    expect(client.ordersAtPrice(2000)).toHaveLength(1);
    expect(client.ordersAtPrice(1980)).toHaveLength(0);

    // Profit pairing unaffected: the fill is in the archive with proper
    // bot attribution, so FIFO/spread pairing sees it like any live fill.
    expect(await db.getFillsForBot(1)).toHaveLength(1);

    // Position matches the grid-implied expectation → no false alert.
    expect(driftEvents).toHaveLength(0);

    // Watermark advanced: tick recorded as successful.
    expect((engine as any).lastMonitorSuccess.get(1)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('does NOT run backfill when ticks are on schedule (no gap)', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id, [5]); // natural gap only — healthy grid
    client.positions = [
      { instrument: PAIR, size: '0.25', unrealized_pnl: '0', entry_price: '1990' },
    ];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const backfillSpy = vi.spyOn(engine, 'backfillFills');

    // Last successful tick 5s ago — well under the 90s trigger.
    (engine as any).lastMonitorSuccess.set(1, Date.now() - 5_000);

    await (engine as any).monitorAllBots();
    expect(backfillSpy).not.toHaveBeenCalled();
  });
});

// ── 2. Restart: resume triggers backfill ─────────────────────────────

describe('resume (loadActiveBots): backfill restores grid coherence after downtime', () => {
  it('processes a fill that happened while the process was down', async () => {
    const { db, client } = downtimeWorld();
    const engine = new GridEngine();
    const driftEvents: any[] = [];
    engine.on('positionDrift', (e) => driftEvents.push(e));

    // Engine restart path: loadActiveBots → resumeBotInstance → backfill.
    await (engine as any).loadActiveBots();

    // Bot resumed and registered.
    expect((engine as any).bots.size).toBe(1);
    expect(db.bots.get(1).status).toBe('running');

    // Grid coherence restored: missed buy flipped, counter sell resting.
    expect(db.archiveFills).toHaveLength(1);
    expect(db.levelAt(1, 4).is_filled).toBe(true);
    expect(db.levelAt(1, 4).state).toBe('filled');
    expect(db.levelAt(1, 5).side).toBe('sell');
    expect(client.calls.createOrder).toHaveLength(1);
    expect(client.calls.createOrder[0]).toMatchObject({ price: '2000', side: 'sell' });
    expect(client.ordersAtPrice(2000)).toHaveLength(1);

    // Position is coherent again → no drift alert.
    expect(driftEvents).toHaveLength(0);

    // Resume seeded the tick watermark so the first monitor tick does not
    // immediately re-trigger the gap backfill.
    expect((engine as any).lastMonitorSuccess.get(1)).toBeGreaterThan(Date.now() - 10_000);

    // And the next monitor tick is quiet: no duplicate counter-orders
    // (loadActiveBots doesn't flip isRunning — start() does — so flip it
    // here to drive one tick).
    (engine as any).isRunning = true;
    await (engine as any).monitorAllBots();
    expect(client.calls.createOrder).toHaveLength(1);
  });
});

// ── 3. Idempotency ───────────────────────────────────────────────────

describe('backfillFills(): idempotency', () => {
  it('running it twice processes each fill exactly once (watermark + archive + processedFills dedup)', async () => {
    const { db, client, instance } = downtimeWorld();
    const engine = makeEngine([[1, instance]]);
    const driftEvents: any[] = [];
    engine.on('positionDrift', (e) => driftEvents.push(e));

    const first = await engine.backfillFills(1);
    expect(first).toMatchObject({ inserted: 1, processed: 1, drift: false });
    expect(client.calls.createOrder).toHaveLength(1);
    expect(db.archiveFills).toHaveLength(1);

    // Second run: the watermark now sits on the recovered fill → nothing
    // new is scanned, nothing inserted, nothing processed, no extra orders.
    const second = await engine.backfillFills(1);
    expect(second).toMatchObject({ scanned: 0, inserted: 0, processed: 0, drift: false });
    expect(client.calls.createOrder).toHaveLength(1);
    expect(db.archiveFills).toHaveLength(1);
    expect(driftEvents).toHaveLength(0);

    // Belt and suspenders below the watermark: the archive insert is
    // INSERT OR IGNORE on fill_id...
    const eventTime = db.archiveFills[0].fill_id;
    expect(await db.insertFillArchive({ fill_id: eventTime, event_time: eventTime, bot_id: 1 })).toBe(false);
    // ...and processedFills rejects the same fill_id at the instance level.
    const replayed = await instance.processBackfilledFill(
      { fill_id: eventTime, price: 1980, size: 0.05, is_buyer: true },
      2008,
      []
    );
    expect(replayed).toBe(false);
  });
});

// ── 4. Position drift → alert only, never auto-trade ─────────────────

describe('backfillFills(): position drift detection', () => {
  it('emits position_drift when live ≠ grid-implied beyond tolerance, places NO corrective orders, bot keeps running', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id); // fully covered — nothing to backfill
    // Grid implies 5 sells × 0.05 = 0.25 long, but GRVT only shows 0.10:
    // 0.15 drift ≫ tolerance (0.5 × 0.05 = 0.025).
    client.positions = [
      { instrument: PAIR, size: '0.10', unrealized_pnl: '0', entry_price: '1990' },
    ];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const driftEvents: any[] = [];
    engine.on('positionDrift', (e) => driftEvents.push(e));

    const result = await engine.backfillFills(1);
    expect(result).toMatchObject({ inserted: 0, processed: 0, drift: true });

    // Alert emitted with full context (ws-dispatcher persists it as a
    // 'position_drift' row in the alerts table — see observability.test.ts).
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]).toMatchObject({ botId: 1, pair: PAIR, liveSize: 0.10 });
    expect(driftEvents[0].expectedSize).toBeCloseTo(0.25, 9);
    expect(driftEvents[0].drift).toBeCloseTo(0.15, 9);
    expect(driftEvents[0].tolerance).toBeCloseTo(0.025, 9);

    // NO orders sent to "fix" the residual — alert only.
    expect(client.calls.createOrder).toHaveLength(0);
    expect(client.calls.cancelAllOrders).toBe(0);

    // Bot keeps running: still registered, status untouched, next tick OK.
    expect((engine as any).bots.size).toBe(1);
    expect(db.bots.get(1).status).toBe('running');
    await (engine as any).monitorAllBots();
    expect(db.bots.get(1).status).toBe('running');
  });

  it('ignores drift within tolerance (no alert)', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id);
    // Drift of 0.02 < tolerance 0.025 (half a level qty) → quiet.
    client.positions = [
      { instrument: PAIR, size: '0.23', unrealized_pnl: '0', entry_price: '1990' },
    ];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const driftEvents: any[] = [];
    engine.on('positionDrift', (e) => driftEvents.push(e));

    const result = await engine.backfillFills(1);
    expect(result!.drift).toBe(false);
    expect(driftEvents).toHaveLength(0);
  });
});

// ── 5. No-gap case: cheap no-op ──────────────────────────────────────

describe('backfillFills(): no-gap no-op', () => {
  it('with the archive already up to date it pages once, inserts nothing, places nothing, alerts nothing', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id, [5]); // healthy: natural gap at idx 5 only
    client.positions = [
      { instrument: PAIR, size: '0.25', unrealized_pnl: '0', entry_price: '1990' },
    ];

    // One recent fill, ALREADY archived (the WS/poller path saw it live).
    const fill = restFill({ fill_id: 'F-live', price: '2000', is_buyer: true }, 30_000);
    client.fills = [fill];
    db.archiveFills.push({
      bot_id: 1,
      fill_id: fill.event_time, // archive keys fills by event_time
      event_time: fill.event_time,
      is_buyer: 1,
      price: 2000,
      size: 0.05,
      fee: 0.01,
    });

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const driftEvents: any[] = [];
    engine.on('positionDrift', (e) => driftEvents.push(e));

    const result = await engine.backfillFills(1);

    expect(result).toMatchObject({ scanned: 0, inserted: 0, processed: 0, drift: false });
    // Single page: the first batch already reaches the watermark.
    expect(client.calls.getFillHistory).toBe(1);
    // No counter-orders, no false drift alert, archive unchanged.
    expect(client.calls.createOrder).toHaveLength(0);
    expect(driftEvents).toHaveLength(0);
    expect(db.archiveFills).toHaveLength(1);
  });
});
