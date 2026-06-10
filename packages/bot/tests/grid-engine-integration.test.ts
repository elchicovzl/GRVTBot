// F4.1 — End-to-end tests for the grid engine monitor loop and the
// SAFEGUARD trigger plumbing in monitorAllBots().
//
// Unlike grid-engine.test.ts (isolated internals), these tests drive the
// REAL monitor() / monitorAllBots() code paths against:
//   - a stateful FakeGrvtClient (controllable ticker, open orders, fill
//     history, per-call order rejections; createOrder/cancelOrder mutate
//     the open-orders book like the real exchange does), and
//   - a stateful FakeDb (in-memory rows for bots / grid_levels / orders /
//     fills_archive implementing exactly the db methods the engine calls).
//
// This suite is the safety net required before parallelizing the monitor
// loop (F4.2): every scenario asserts on observable end state (DB rows,
// exchange book, emitted events), not on internal call wiring.
//
// All tests are deterministic: monitor()/monitorAllBots() are invoked
// directly — no intervals, no fake-timer juggling. The only real waits are
// the engine's own intra-tick throttles (200ms per counter-order), well
// under the 10s test timeout.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────
// grid-engine.ts imports the GRVT client singleton, the per-user client
// factory, and the db singleton at module level. We swap all three for
// holders we can re-point per test (the proxy delegates every access to
// holder.current, so each test gets fresh fakes without re-importing).

const { clientHolder, dbHolder, singletonClientProxy, dbProxy } = vi.hoisted(() => {
  // Silence pino before grid-engine.ts builds its child logger.
  process.env.LOG_LEVEL = 'silent';
  delete process.env.DRY_RUN;
  // F2.3: shrink the close-verify poll interval (real setTimeout waits) so
  // the escalation scenarios — which must exhaust full reprice cycles —
  // stay well under the 10s test timeout. Read once at module load by
  // grid-engine.ts's envTunable().
  process.env.GRVT_CLOSE_POLL_INTERVAL_MS = '40';

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
  // ETH-like spec. min_notional=1 keeps qty*price validation permissive.
  getInstrumentSpec: () => ({ min_size: 0.01, min_notional: 1 }),
}));

vi.mock('../src/api/grvt-client-factory.js', () => ({
  // Bots in this suite have user_id=undefined so the engine never routes
  // through the factory — but mock it anyway so an accidental call fails
  // loudly instead of hitting real credential decryption.
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

/** GRVT-shaped open order as returned by getOpenOrders(). */
interface FakeOpenOrder {
  order_id: string;
  legs: Array<{ limit_price: string; is_buying_asset: boolean }>;
  metadata?: { client_order_id?: string };
}

class FakeGrvtClient {
  price = 2000;
  openOrders: FakeOpenOrder[] = [];
  /** REST fill history (getFillHistory). */
  fills: any[] = [];
  /** Account balance for the margin-brake headroom check (getBalance).
   *  Generous defaults so the P0 cross-margin brake passes its projection
   *  unless a test deliberately shrinks the equity. */
  totalEquity = 1_000_000;
  marginUsed = 0;
  positions: Array<{ instrument: string; size: string; unrealized_pnl: string; entry_price: string }> = [];
  /** Per-call createOrder failure queue (null = succeed). */
  createOrderErrors: Array<Error | null> = [];
  /** When set, getOpenOrders rejects (simulates GRVT outage). */
  openOrdersError: Error | null = null;
  /** F2.3: when true, non-post_only LIMIT takers REST instead of filling —
   *  simulates a fast market / gap where the aggressive limit close chases
   *  the price and never catches it. MARKET orders still fill (they cross
   *  the book by definition). */
  stallLimitTakers = false;
  /** F2.3: one-shot partial fill applied to the first STALLED limit close —
   *  models a partial execution before escalation so tests can assert the
   *  market order is sized to the REMAINING position, not the original. */
  partialFillOnStall = 0;

  orderSeq = 0;
  calls = {
    createOrder: [] as any[],
    cancelOrder: [] as string[],
    cancelAllOrders: 0,
    getTicker: 0,
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

  async getFillHistory(_limit: number, _pair?: string) {
    return [...this.fills];
  }

  async getPosition(pair: string) {
    return this.positions.find((p) => p.instrument === pair) ?? null;
  }

  async getPositions() {
    return [...this.positions];
  }

  /** P0 margin brake: assertMarginHeadroom() projects against this. */
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

    // Exchange semantics for TAKER orders: a non-post_only limit priced
    // through the market (sell below / buy above last price) fills
    // immediately instead of resting. This is exactly what the P0 verified
    // close does (aggressive GTC reduce_only) — without it, closeBot()'s
    // position poll would never see the account flatten. Grid orders are
    // always post_only:true, so they keep resting as before.
    //
    // F2.3: MARKET orders always cross. stallLimitTakers makes limit takers
    // rest (fast-market simulation) — market orders are unaffected.
    const isMarket = params.type === 'market';
    const px = isMarket ? this.price : parseFloat(params.price);
    const crosses = isMarket || (params.side === 'sell' ? px <= this.price : px >= this.price);
    const stalled = this.stallLimitTakers && !isMarket;

    if (!params.post_only && crosses && !stalled) {
      const pos = this.positions.find((p) => p.instrument === params.instrument);
      if (pos) {
        const delta = parseFloat(params.size) * (params.side === 'sell' ? -1 : 1);
        const newSize = parseFloat(pos.size) + delta;
        if (Math.abs(newSize) < 1e-9 || (params.reduce_only && parseFloat(pos.size) * newSize <= 0)) {
          this.positions = this.positions.filter((p) => p !== pos); // flat (reduce_only never flips)
        } else {
          pos.size = String(newSize);
        }
      }
      return { order_id, metadata: params.metadata }; // filled, never rests
    }

    // F2.3: one-shot PARTIAL execution of a stalled limit close — the
    // remainder rests on the book like the real exchange would.
    if (stalled && crosses && this.partialFillOnStall > 0) {
      const pos = this.positions.find((p) => p.instrument === params.instrument);
      if (pos) {
        const delta = this.partialFillOnStall * (params.side === 'sell' ? -1 : 1);
        pos.size = String(parseFloat(pos.size) + delta);
      }
      this.partialFillOnStall = 0;
    }

    if (isMarket) {
      // IOC market that found no position to reduce: never rests.
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

  /** Seed a resting order on the book at a grid level's price. */
  coverLevel(level: { price: number; side: string }): string {
    const order_id = `seed_${++this.orderSeq}`;
    this.openOrders.push({
      order_id,
      legs: [{ limit_price: String(level.price), is_buying_asset: level.side === 'buy' }],
    });
    return order_id;
  }

  /** Remove the book order resting at a price (simulates fill/cancel on GRVT). */
  removeOrderAtPrice(price: number): void {
    this.openOrders = this.openOrders.filter(
      (o) => Math.abs(parseFloat(o.legs[0]!.limit_price) - price) > 0.001
    );
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
  /** fills_archive rows: { bot_id, fill_id, event_time(ns string), is_buyer, price, size, fee } */
  archiveFills: any[] = [];
  updateBotCalls: Array<{ id: number; updates: any }> = [];
  /** F2.3: alerts table rows recorded via recordAlert (close_escalated audit). */
  alerts: any[] = [];
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

  async sumPairedRoundtripProfit(_botId: number) { return 0; }
  async sumFeesForBot(_botId: number) { return 0; }
  async insertPairedRoundtrip(_p: any) {}
  // P0: updatePnL() now folds net funding into total_pnl (and SL/TP fire on
  // it). No funding snapshots in these scenarios → 0, same as the real
  // implementation's fail-safe. Without this method the TypeError would be
  // eaten by updatePnL's catch and silently disable the SL/TP safeguard.
  async getNetFundingForBot(_botId: number) { return 0; }

  // F2.3: closeBot() audits market escalations in the alerts table.
  async recordAlert(params: any) {
    this.alerts.push({ ...params });
    return this.alerts.length;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const PAIR = 'ETH_USDT_Perp';

// Grid: 1900..2100, 10 grids → 11 levels every $20 (idx i = 1900 + 20i).
function makeBot(overrides: Record<string, any> = {}): any {
  return {
    id: 1,
    user_id: undefined, // route through the (mocked) singleton client
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

/** Create the bot's grid levels in the fake DB. Side derived from refPrice. */
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

/** Put resting GRVT orders on every non-virtual level except `exceptIdx`. */
function coverGrid(client: FakeGrvtClient, db: FakeDb, botId: number, exceptIdx: number[] = []): void {
  for (const level of db.levels.filter((l) => l.bot_id === botId)) {
    if (exceptIdx.includes(level.level_index)) continue;
    if (level.state === 'virtual') continue;
    const orderId = client.coverLevel(level);
    level.order_id = orderId;
  }
}

/** REST-shaped fill (GRVT getFillHistory). event_time in nanoseconds. */
function restFill(over: Record<string, any> = {}): any {
  return {
    fill_id: 'F1',
    order_id: 'seed_x',
    client_order_id: 'c1',
    price: '1980',
    size: '0.05',
    fee: '0.01',
    fee_currency: 'USDT',
    is_buyer: true,
    event_time: String(Date.now() * 1_000_000),
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
  clientHolder.current = client; // singleton fallback (closeBot path)
  return { db, client };
}

/** Build a GridEngine with `bots` pre-registered, bypassing start()'s intervals. */
function makeEngine(instances: Array<[number, GridBotInstance]>): GridEngine {
  const engine = new GridEngine();
  (engine as any).isRunning = true; // monitorAllBots() guard
  for (const [id, inst] of instances) (engine as any).bots.set(id, inst);
  return engine;
}

beforeEach(() => {
  dbHolder.current = null;
  clientHolder.current = null;
});

// ── 1. Uncovered level re-placement ──────────────────────────────────

describe('monitor(): uncovered level re-placement', () => {
  it('re-places a level whose order vanished from GRVT and is not in fill history', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    // Two holes in coverage: idx 5 ($2000, dist $8 → natural gap) and
    // idx 2 ($1940, dist $68 → vanished order that must be re-placed).
    coverGrid(client, db, bot.id, [5, 2]);
    // No fills anywhere (REST + archive empty) → idx 2 is NOT a fill.

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    await instance.monitor();

    // Closest uncovered level became the natural gap, NOT re-placed.
    expect(db.levelAt(1, 5).is_filled).toBe(true);
    expect(client.ordersAtPrice(2000)).toHaveLength(0);

    // The far uncovered level got re-placed as a buy (price < market).
    const placed = client.calls.createOrder;
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      instrument: PAIR,
      price: '1940',
      side: 'buy',
      size: '0.05',
      post_only: true,
    });
    // And it is now live on the book + recorded in the orders table.
    expect(client.ordersAtPrice(1940)).toHaveLength(1);
    expect(db.orders.some((o) => o.price === 1940 && o.side === 'buy' && o.grid_level_id === db.levelAt(1, 2).id)).toBe(true);
  });

  it('does not re-place a level inside the 10s GRVT-lag window', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id, [5, 2]);

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    // Simulate "we placed this 1s ago, GRVT hasn't surfaced it yet".
    (instance as any).recentlyPlaced.set(db.levelAt(1, 2).id, Date.now() - 1000);

    await instance.monitor();
    expect(client.calls.createOrder).toHaveLength(0);
  });
});

// ── 2. Fill → counter-order ──────────────────────────────────────────

describe('monitor(): fill detection → counter-order', () => {
  it('detects a buy fill via REST history and places the counter sell one level up', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    // idx 5 ($2000) = natural gap; idx 4 ($1980) = buy order that filled
    // (gone from openOrders, present in fill history).
    coverGrid(client, db, bot.id, [5, 4]);
    client.fills = [restFill({ fill_id: 'F1', price: '1980', is_buyer: true })];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    await instance.monitor();

    // Counter SELL placed at the adjacent level UP (idx 5 → $2000).
    const counters = client.calls.createOrder;
    expect(counters).toHaveLength(1);
    expect(counters[0]).toMatchObject({ price: '2000', side: 'sell', size: '0.05' });
    expect(client.ordersAtPrice(2000)).toHaveLength(1);

    // Filled level stays empty (the gap); counter level flipped to sell.
    expect(db.levelAt(1, 4).is_filled).toBe(true);
    expect(db.levelAt(1, 4).state).toBe('filled');
    expect(db.levelAt(1, 5).side).toBe('sell');
    expect(db.levelAt(1, 5).is_filled).toBe(false);
    expect(db.levelAt(1, 5).state).toBe('active');
  });
});

// ── 3. Fill deduplication ────────────────────────────────────────────

describe('monitor(): fill deduplication (REST + archive)', () => {
  it('processes the same fill_id once even when re-reported by the archive on a later tick', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id, [5, 4]);
    client.fills = [restFill({ fill_id: 'F1', price: '1980', is_buyer: true })];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);

    // Tick 1: fill detected via REST → counter sell placed at $2000.
    await instance.monitor();
    expect(client.calls.createOrder).toHaveLength(1);

    // Tick 2: the counter order hasn't surfaced on GRVT yet (lag) and the
    // SAME fill now arrives via the WS-backed archive (fills_archive).
    client.removeOrderAtPrice(2000); // counter not visible on book yet
    client.fills = []; // REST window rolled over
    db.archiveFills.push({
      bot_id: 1,
      fill_id: 'F1', // same fill, second source
      event_time: String(Date.now() * 1_000_000),
      is_buyer: 1,
      price: 1980,
      size: 0.05,
      fee: 0.01,
    });

    await instance.monitor();

    // No double-processing: no second counter order was sent to GRVT.
    expect(client.calls.createOrder).toHaveLength(1);
    expect(db.levelAt(1, 4).is_filled).toBe(true);
  });
});

// ── 4. SAFEGUARD triggers via monitorAllBots ─────────────────────────

describe('monitorAllBots(): SAFEGUARD triggers', () => {
  it('liquidation-proximity SAFEGUARD pauses the bot instead of crashing the engine', async () => {
    const { db, client } = setupWorld();
    // long 5x, entry $2000 → local liq ≈ $1610. Mark $1700 → distance
    // ≈5.3% ≤ threshold 10% → SAFEGUARD:pause.
    const bot = makeBot({
      safeguard_enabled: 1,
      safeguard_threshold_pct: 10,
      safeguard_action: 'pause',
      avg_entry_price: 2000,
      position_size: 0.5,
    });
    db.addBot(bot);
    seedGrid(db, bot, 1700);
    client.price = 1700;
    coverGrid(client, db, bot.id);

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const events: any[] = [];
    engine.on('safeguardTriggered', (e) => events.push(e));

    // Must resolve — the SAFEGUARD throw is handled, never propagated.
    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // Status change persisted, orders cancelled, monitoring stops.
    expect(db.bots.get(1).status).toBe('paused');
    expect(client.calls.cancelAllOrders).toBe(1);
    expect((engine as any).bots.size).toBe(0);

    expect(events).toHaveLength(1);
    expect(events[0].botId).toBe(1);
    expect(events[0].action).toBe('pause');
    expect(events[0].reason).toContain('SAFEGUARD:pause');

    // A subsequent sweep is a no-op (bot removed from the loop).
    await (engine as any).monitorAllBots();
    expect(events).toHaveLength(1);
  });

  it('stop-loss SAFEGUARD (pause_close) routes to closeBot: cancels, closes position, persists stopped', async () => {
    const { db, client } = setupWorld();
    // sl_pct=10 on $1000 investment; unrealized PnL -$150 → 15% loss → SL.
    const bot = makeBot({ sl_pct: 10, position_size: 0.5, avg_entry_price: 2000 });
    db.addBot(bot);
    seedGrid(db, bot, 2000);
    client.price = 2000;
    coverGrid(client, db, bot.id); // fully covered → no order churn before PnL check
    client.positions = [
      { instrument: PAIR, size: '0.5', unrealized_pnl: '-150', entry_price: '2000' },
    ];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const events: any[] = [];
    engine.on('safeguardTriggered', (e) => events.push(e));

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // closeBot path: orders cancelled, aggressive close order sent, stopped.
    expect(client.calls.cancelAllOrders).toBe(1);
    const closeOrder = client.calls.createOrder.find((o) => o.side === 'sell' && o.size === '0.5');
    expect(closeOrder).toBeDefined();
    expect(closeOrder).toMatchObject({ time_in_force: 'gtc', price: '1990' }); // 0.5% below mark
    expect(db.bots.get(1).status).toBe('stopped');
    expect((engine as any).bots.size).toBe(0);

    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('pause_close');
    expect(events[0].reason).toContain('SL triggered');
  });
});

// ── 4.5 SL/TP market-order escalation (F2.3) ─────────────────────────

describe('closeBot(): SL/TP market-order escalation (F2.3)', () => {
  /** SL-triggered bot: sl_pct=10 on $1000 investment, PnL -$150 → 15% loss. */
  function seedSlBot(db: FakeDb, client: FakeGrvtClient, botOverrides: Record<string, any> = {}) {
    const bot = makeBot({ sl_pct: 10, position_size: 0.5, avg_entry_price: 2000, ...botOverrides });
    db.addBot(bot);
    seedGrid(db, bot, 2000);
    client.price = 2000;
    coverGrid(client, db, bot.id); // fully covered → no order churn before the PnL check
    client.positions = [
      { instrument: PAIR, size: '0.5', unrealized_pnl: '-150', entry_price: '2000' },
    ];
    return bot;
  }

  it('normal market: aggressive limit close fills — NO escalation, no market order, no alert', async () => {
    const { db, client } = setupWorld();
    seedSlBot(db, client);

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const escalations: any[] = [];
    engine.on('closeEscalated', (e) => escalations.push(e));

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // Default path unchanged: ONE aggressive GTC limit close, position flat.
    const closes = client.calls.createOrder;
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ side: 'sell', size: '0.5', type: 'limit', time_in_force: 'gtc', reduce_only: true });
    // No market order, no escalation event, no audit alert.
    expect(closes.some((o) => o.type === 'market')).toBe(false);
    expect(escalations).toHaveLength(0);
    expect(db.alerts).toHaveLength(0);
    expect(db.bots.get(1).status).toBe('stopped');
  });

  it('stalled limit: escalates after the first failed reprice cycle — market is reduce_only, sized to the REMAINING position, bot stopped, close_escalated alert recorded', async () => {
    const { db, client } = setupWorld();
    seedSlBot(db, client);
    // Fast market: the aggressive limit close rests instead of filling, but
    // executes a 0.2 partial before stalling → remaining position is 0.3.
    client.stallLimitTakers = true;
    client.partialFillOnStall = 0.2;

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const escalations: any[] = [];
    engine.on('closeEscalated', (e) => escalations.push(e));

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // Phase 1: exactly ONE limit attempt (the first reprice cycle), then
    // escalation — no limit chase across all 4 reprice retries.
    const limitCloses = client.calls.createOrder.filter((o) => o.type === 'limit');
    expect(limitCloses).toHaveLength(1);
    expect(limitCloses[0]).toMatchObject({ side: 'sell', size: '0.5', time_in_force: 'gtc' });

    // Phase 2: market escalation — reduce_only, IOC, sized to the REMAINING
    // 0.3 (live position re-read AFTER the 0.2 partial), not the original 0.5.
    const marketCloses = client.calls.createOrder.filter((o) => o.type === 'market');
    expect(marketCloses).toHaveLength(1);
    expect(marketCloses[0]).toMatchObject({
      side: 'sell',
      size: '0.3',
      time_in_force: 'ioc',
      reduce_only: true,
    });

    // The stalled limit was cancelled BEFORE the market went out (no stacking).
    expect(client.calls.cancelOrder.length).toBeGreaterThanOrEqual(1);

    // End state: flat, stopped, audited.
    expect(client.positions).toHaveLength(0);
    expect(db.bots.get(1).status).toBe('stopped');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ botId: 1, side: 'sell', size: 0.3 });
    const alert = db.alerts.find((a) => a.type === 'close_escalated');
    expect(alert).toBeDefined();
    expect(alert).toMatchObject({ user_id: 1, bot_id: 1, severity: 'info' });
    expect(alert.message).toContain('MARKET sell 0.3');
  });

  it('gap >2% at SL trigger: limit phase skipped entirely — straight to market', async () => {
    const { db, client } = setupWorld();
    // Healthy first tick: small loss (5% < sl 10%) at $2000 seeds the
    // previous-tick price for gap detection.
    seedSlBot(db, client);
    client.positions = [
      { instrument: PAIR, size: '0.5', unrealized_pnl: '-50', entry_price: '2000' },
    ];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const escalations: any[] = [];
    const safeguards: any[] = [];
    engine.on('closeEscalated', (e) => escalations.push(e));
    engine.on('safeguardTriggered', (e) => safeguards.push(e));

    await (engine as any).monitorAllBots(); // tick 1: no SL, records $2000
    expect(db.bots.get(1).status).toBe('running');

    // Tick 2: price gaps down 5% (>2% threshold) and SL crosses. Stall limit
    // takers so that, if the limit phase ran by mistake, it would be visible.
    client.price = 1900;
    client.positions = [
      { instrument: PAIR, size: '0.5', unrealized_pnl: '-150', entry_price: '2000' },
    ];
    client.stallLimitTakers = true;

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // The SAFEGUARD throw carried the gap token for the fast-path routing.
    expect(safeguards).toHaveLength(1);
    expect(safeguards[0].reason).toMatch(/SL triggered.*:gap=5\.00%/);

    // NO limit close was ever attempted — straight to market.
    expect(client.calls.createOrder.filter((o) => o.type === 'limit')).toHaveLength(0);
    const marketCloses = client.calls.createOrder.filter((o) => o.type === 'market');
    expect(marketCloses).toHaveLength(1);
    expect(marketCloses[0]).toMatchObject({ side: 'sell', size: '0.5', time_in_force: 'ioc', reduce_only: true });

    expect(client.positions).toHaveLength(0);
    expect(db.bots.get(1).status).toBe('stopped');
    expect(escalations).toHaveLength(1);
    const alert = db.alerts.find((a) => a.type === 'close_escalated');
    expect(alert).toBeDefined();
    expect(alert.message).toContain('gap fast-path');
  });

  it('close_escalation=0 (opt-out): identical to the legacy verified close — full reprice retries, fail-closed pause, never a market order', async () => {
    const { db, client } = setupWorld();
    seedSlBot(db, client, { close_escalation: 0 });
    client.stallLimitTakers = true; // limit closes never fill

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const escalations: any[] = [];
    const closeFailures: any[] = [];
    engine.on('closeEscalated', (e) => escalations.push(e));
    engine.on('botCloseFailed', (e) => closeFailures.push(e));

    // closeBot() throws fail-closed inside the safeguard handler — contained.
    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // Legacy behavior: all 4 reprice attempts (1 + CLOSE_MAX_REPRICE_RETRIES),
    // every one a GTC limit, ZERO market orders, no escalation, no alert.
    const closes = client.calls.createOrder;
    expect(closes).toHaveLength(4);
    expect(closes.every((o) => o.type === 'limit' && o.time_in_force === 'gtc' && o.reduce_only === true)).toBe(true);
    expect(escalations).toHaveLength(0);
    expect(db.alerts.filter((a) => a.type === 'close_escalated')).toHaveLength(0);

    // Fail-closed: 'paused' (NOT stopped/deletable), residual persisted,
    // botCloseFailed emitted with the legacy reason.
    expect(db.bots.get(1).status).toBe('paused');
    expect(db.bots.get(1).position_size).toBeCloseTo(0.5);
    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0].reason).toContain('4 close attempts');
  });

  it('market order itself fails: fail-closed pause preserved (never silently gives up), escalation still audited', async () => {
    const { db, client } = setupWorld();
    seedSlBot(db, client);
    client.stallLimitTakers = true;
    // 1st createOrder = limit close (succeeds, rests). 2nd = market escalation → rejected.
    client.createOrderErrors = [null, new Error('HTTP 500: GRVT matching engine unavailable')];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const closeFailures: any[] = [];
    engine.on('botCloseFailed', (e) => closeFailures.push(e));

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // Escalation fired and was audited even though the market order failed.
    expect(client.calls.createOrder.filter((o) => o.type === 'market')).toHaveLength(1);
    expect(db.alerts.filter((a) => a.type === 'close_escalated')).toHaveLength(1);

    // Fail-closed invariant preserved: paused with the REAL residual, not
    // stopped, and the failure surfaced via botCloseFailed.
    expect(db.bots.get(1).status).toBe('paused');
    expect(db.bots.get(1).position_size).toBeCloseTo(0.5);
    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0].reason).toContain('market escalation');
  });
});

// ── 5. MARGIN brake (P0 mainnet safety hardening) ────────────────────

describe('monitor(): insufficient-margin rejection during re-placement', () => {
  // P0 (fc49d52) added the cross-margin brake: MARGIN_BRAKE_ENABLED is a
  // hard-coded `true` in grid-engine.ts (not env-gated), and placeGridOrder
  // converts a GRVT rejection matching INSUFFICIENT_MARGIN_RE into a
  // structured 'MARGIN:pause:bot=N:grvt_reject' error. The re-place loop in
  // monitor() re-throws 'MARGIN:' errors instead of containing them, and
  // monitorAllBots() routes them to pauseBot() — ALWAYS pause, never
  // auto-close (closing could itself require margin on an exhausted
  // account) — reusing the safeguardTriggered event for WS consumers.
  // This replaces the pre-P0 pin where the rejection was silently swallowed
  // and the bot kept placing orders against an exhausted account.
  it('routes a GRVT insufficient-margin rejection to the margin pause path: bot paused, orders cancelled, event emitted', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id, [5, 2]); // idx 2 will be re-placed

    // GRVT rejects the placement with an insufficient-margin style error
    // (matches INSUFFICIENT_MARGIN_RE: /insufficient.*margin|.../i).
    client.createOrderErrors = [new Error('CREATE_ORDER failed: code 3022 Insufficient margin')];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const events: any[] = [];
    engine.on('safeguardTriggered', (e) => events.push(e));

    // The MARGIN throw is handled inside monitorAllBots, never propagated.
    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // The placement was attempted once and rejected — no retry storm.
    expect(client.calls.createOrder).toHaveLength(1);
    expect(client.ordersAtPrice(1940)).toHaveLength(0);

    // Brake fired: bot paused (NOT auto-closed), resting orders cancelled,
    // bot removed from the monitoring loop.
    expect(db.bots.get(1).status).toBe('paused');
    expect(client.calls.cancelAllOrders).toBe(1);
    expect(client.openOrders).toHaveLength(0);
    expect((engine as any).bots.size).toBe(0);
    // Pause, not close: the only createOrder ever sent was the rejected buy
    // (no aggressive close order against an exhausted account).
    expect(client.calls.createOrder).toHaveLength(1);

    // safeguardTriggered reused for the margin brake, action is ALWAYS pause.
    expect(events).toHaveLength(1);
    expect(events[0].botId).toBe(1);
    expect(events[0].action).toBe('pause');
    expect(events[0].reason).toContain('MARGIN:pause');
    expect(events[0].reason).toContain('grvt_reject');

    // A subsequent sweep is a no-op (bot removed from the loop).
    await (engine as any).monitorAllBots();
    expect(events).toHaveLength(1);
  });

  // GAP (feeds F2.1): INSUFFICIENT_MARGIN_RE is flagged in the source as
  // UNCONFIRMED against a real GRVT rejection. If GRVT's actual error body
  // never says "margin"/"insufficient margin" (e.g. a bare numeric code or
  // "BALANCE_TOO_LOW"), the brake does NOT fire and the pre-P0 behavior
  // remains: the re-place loop contains the failure, the bot keeps running,
  // and the level is retried on later ticks. This test documents that gap
  // so F2.1 (confirm the real signature + fallback) must consciously
  // change it.
  it('does NOT trigger the brake for a rejection that misses INSUFFICIENT_MARGIN_RE (unconfirmed-signature gap, F2.1)', async () => {
    const { db, client } = setupWorld();
    const bot = makeBot();
    db.addBot(bot);
    seedGrid(db, bot, 2008);
    client.price = 2008;
    coverGrid(client, db, bot.id, [5, 2]); // idx 2 will be re-placed

    // Plausible GRVT rejection for the same underlying condition that does
    // NOT match the regex (no "margin" wording at all).
    client.createOrderErrors = [new Error('HTTP 400: {"code":3022,"message":"BALANCE_TOO_LOW"}')];

    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    const engine = makeEngine([[1, instance]]);
    const events: any[] = [];
    engine.on('safeguardTriggered', (e) => events.push(e));

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // The placement was attempted and rejected...
    expect(client.calls.createOrder).toHaveLength(1);
    expect(client.ordersAtPrice(1940)).toHaveLength(0);
    // ...but the brake did NOT fire: contained by the re-place loop, no
    // pause, no event, bot still monitored next tick.
    expect(db.bots.get(1).status).toBe('running');
    expect(client.calls.cancelAllOrders).toBe(0);
    expect(events).toHaveLength(0);
    expect((engine as any).bots.size).toBe(1);
    // Not routed to the 7201 pending_replace path either (different error).
    expect(db.levelAt(1, 2).pending_replace).toBeFalsy();
  });
});

// ── 6. Error isolation in monitorAllBots ─────────────────────────────

describe('monitorAllBots(): error isolation', () => {
  it('one bot throwing a non-SAFEGUARD error does not prevent other bots from being monitored', async () => {
    const { db } = setupWorld();

    // Bot 1: its GRVT client is down — monitor() throws immediately.
    const failingClient = new FakeGrvtClient();
    failingClient.openOrdersError = new Error('GRVT 500: upstream unavailable');
    const bot1 = makeBot({ id: 1 });
    db.addBot(bot1);
    seedGrid(db, bot1, 2008);

    // Bot 2: healthy, fully covered grid.
    const healthyClient = new FakeGrvtClient();
    healthyClient.price = 2008;
    const bot2 = makeBot({ id: 2, pair: 'BTC_USDT_Perp' });
    db.addBot(bot2);
    seedGrid(db, bot2, 2008);
    coverGrid(healthyClient, db, 2);

    const inst1 = new GridBotInstance(db.bots.get(1) as any, failingClient as any);
    const inst2 = new GridBotInstance(db.bots.get(2) as any, healthyClient as any);
    // Failing bot FIRST so a crash would shadow bot 2.
    const engine = makeEngine([[1, inst1], [2, inst2]]);

    await expect((engine as any).monitorAllBots()).resolves.toBeUndefined();

    // Bot 2 was fully monitored (ticker read happens after open-orders).
    expect(healthyClient.calls.getTicker).toBeGreaterThanOrEqual(1);
    // Generic errors do NOT pause: both bots stay registered and running.
    expect((engine as any).bots.size).toBe(2);
    expect(db.bots.get(1).status).toBe('running');
    expect(db.bots.get(2).status).toBe('running');
  });
});

// ── 7. Virtual window rotation (H.8) ─────────────────────────────────

describe('monitor(): virtual window rotation (H.8)', () => {
  // 17 levels (1900..2220, $20 step), window M=6. Active window starts at
  // the bottom (idx 0-5); price jumps to $2210 (top of range) → rotation
  // must virtualize the 6 far actives and activate the 6 near virtuals,
  // capped at 5 cancels + 5 placements per tick, converging on tick 2.
  function rotationWorld() {
    const { db, client } = setupWorld();
    const bot = makeBot({
      lower_price: 1900,
      upper_price: 2220,
      num_grids: 16,
      virtual_enabled: 1,
      active_window_size: 6,
    });
    db.addBot(bot);
    seedGrid(db, bot, 2210);
    // Bottom 6 levels active (orders on book), the rest virtual.
    for (const l of db.levels) {
      if (l.level_index > 5) Object.assign(l, { state: 'virtual', order_id: null });
    }
    client.price = 2210;
    coverGrid(client, db, bot.id); // covers only the 6 active levels
    const instance = new GridBotInstance(db.bots.get(1) as any, client as any);
    return { db, client, instance };
  }

  it('tick 1: virtualizes far actives and activates near virtuals, respecting the 5-ops-per-tick cap', async () => {
    const { db, client, instance } = rotationWorld();

    await instance.monitor();

    // Cap respected: exactly 5 cancels and 5 placements.
    expect(client.calls.cancelOrder).toHaveLength(5);
    expect(client.calls.createOrder).toHaveLength(5);

    // Virtualized nearest-first among the out-of-window actives: idx 5..1.
    for (const idx of [5, 4, 3, 2, 1]) {
      expect(db.levelAt(1, idx).state).toBe('virtual');
      expect(db.levelAt(1, idx).order_id).toBeNull();
    }
    // idx 0 still active — over budget this tick.
    expect(db.levelAt(1, 0).state).toBe('active');

    // Activated the 5 closest virtuals (idx 16..12); idx 11 still pending.
    for (const idx of [16, 15, 14, 13, 12]) {
      expect(db.levelAt(1, idx).state).toBe('active');
      const price = 1900 + idx * 20;
      expect(client.ordersAtPrice(price)).toHaveLength(1);
    }
    expect(db.levelAt(1, 11).state).toBe('virtual');
  });

  it('tick 2: converges — window fully rotated to the 6 levels nearest price', async () => {
    const { db, client, instance } = rotationWorld();

    await instance.monitor();
    await instance.monitor();

    // Final window = idx 11..16; everything below is virtual.
    for (const idx of [11, 12, 13, 14, 15, 16]) {
      expect(db.levelAt(1, idx).state).toBe('active');
    }
    for (const idx of [0, 1, 2, 3, 4, 5]) {
      expect(db.levelAt(1, idx).state).toBe('virtual');
      expect(db.levelAt(1, idx).order_id).toBeNull();
    }

    // The book holds exactly the 6 in-window orders ($2120..$2220).
    expect(client.openOrders).toHaveLength(6);
    const bookPrices = client.openOrders
      .map((o) => parseFloat(o.legs[0]!.limit_price))
      .sort((a, b) => a - b);
    expect(bookPrices).toEqual([2120, 2140, 2160, 2180, 2200, 2220]);

    // Total ops across both ticks: 6 cancels, 6 placements.
    expect(client.calls.cancelOrder).toHaveLength(6);
    expect(client.calls.createOrder).toHaveLength(6);
  });
});
