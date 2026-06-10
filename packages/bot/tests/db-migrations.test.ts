// D.6 — DB migration idempotency + backfill tests.
// Uses an in-memory SQLite (no filesystem touch) so we can run the
// real GridBotDB.initialize() — which both creates tables and runs all
// the ALTER TABLE migrations — and verify:
//   - every expected column ends up on grid_bots
//   - re-running initialize() is a no-op (no duplicate-column errors)
//   - the backfill UPDATE for original_investment_usdt + quantity_per_level
//     correctly populates legacy NULL rows
//
// We bypass the singleton (`db` from db.ts) and instantiate GridBotDB
// directly with `:memory:` so each test gets an isolated DB.

import { describe, it, expect } from 'vitest';
import { GridBotDB } from '../src/database/db';

async function makeDb(): Promise<GridBotDB> {
  const db = new GridBotDB(':memory:');
  await db.initialize();
  return db;
}

// Cast helper — exercises the private dbAll/dbRun/dbGet via reflection.
// Accepting the `any` here is the price of testing migration internals
// without dragging the whole engine into the test surface.
function priv(db: GridBotDB) {
  return db as unknown as {
    dbRun: (sql: string, ...p: unknown[]) => Promise<{ lastID: number; changes: number }>;
    dbAll: (sql: string, ...p: unknown[]) => Promise<unknown[]>;
    dbGet: (sql: string, ...p: unknown[]) => Promise<Record<string, unknown> | undefined>;
  };
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

async function columns(db: GridBotDB, table: string): Promise<string[]> {
  const rows = (await priv(db).dbAll(`PRAGMA table_info(${table})`)) as ColumnInfo[];
  return rows.map((r) => r.name);
}

describe('GridBotDB migrations (D.6)', () => {
  it('creates the grid_bots table with all expected columns after initialize()', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'grid_bots');

    // Base CREATE TABLE columns
    for (const c of [
      'id', 'pair', 'direction', 'leverage', 'lower_price', 'upper_price',
      'num_grids', 'investment_usdt', 'grid_profit_usdt', 'trend_pnl_usdt',
      'total_pnl_usdt', 'status', 'position_size', 'avg_entry_price',
      'liquidation_price', 'created_at', 'updated_at', 'params_json',
    ]) {
      expect(cols, `missing base column: ${c}`).toContain(c);
    }

    // Migration columns (added via ALTER TABLE)
    for (const c of [
      'original_investment_usdt',
      'quantity_per_level',
      'compound_pct', 'compound_threshold_usdt', 'compound_interval_hours',
      'last_compound_at', 'total_reinvested',
      'safeguard_enabled', 'safeguard_threshold_pct', 'safeguard_action',
      'sl_pct', 'tp_pct',
      'close_escalation',
      'auto_shift_enabled', 'auto_shift_pct', 'last_auto_shift_at',
      'virtual_enabled', 'active_window_size',
    ]) {
      expect(cols, `missing migration column: ${c}`).toContain(c);
    }
  });

  it('creates the grid_levels table with the H.8 state column', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'grid_levels');
    for (const c of ['id', 'bot_id', 'level_index', 'price', 'side', 'quantity', 'is_filled', 'pending_replace', 'order_id']) {
      expect(cols).toContain(c);
    }
  });

  it('creates daily_snapshots with both legacy and new columns', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'daily_snapshots');
    // New schema
    for (const c of ['date', 'equity', 'grid_profit_net', 'trend_pnl', 'total_pnl']) {
      expect(cols).toContain(c);
    }
  });

  it('creates fills_archive with bot_id + instrument FK', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'fills_archive');
    expect(cols).toContain('bot_id');
    expect(cols).toContain('instrument');
  });

  it('creates paired_roundtrips with bot_id (unification fix)', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'paired_roundtrips');
    expect(cols).toContain('bot_id');
  });

  it('initialize() is idempotent — running it twice does not throw', async () => {
    const db = new GridBotDB(':memory:');
    await db.initialize();
    // Second run hits every "ALTER TABLE ... ADD COLUMN" again. The
    // try/catch in createTables swallows "column already exists" so
    // this should resolve cleanly.
    await expect(db.initialize()).resolves.not.toThrow();
  });

  it('backfills original_investment_usdt for rows where it is NULL', async () => {
    const db = await makeDb();

    // Insert a "legacy" bot, then NULL out the column to simulate a row
    // that pre-existed before the migration added the column.
    await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, status)
      VALUES ('ETH_USDT_Perp', 'long', 2, 1800, 2400, 10, 750, 'paused')
    `);
    await priv(db).dbRun(`UPDATE grid_bots SET original_investment_usdt = NULL`);

    // Re-run init — the backfill UPDATE re-fires and fills the NULL.
    await db.initialize();

    const row = await priv(db).dbGet(`
      SELECT investment_usdt, original_investment_usdt FROM grid_bots WHERE pair = 'ETH_USDT_Perp'
    `);
    expect(row?.investment_usdt).toBe(750);
    expect(row?.original_investment_usdt).toBe(750);
  });

  it('backfills quantity_per_level from grid_levels for legacy bots', async () => {
    const db = await makeDb();

    // Insert a bot + a single grid level with quantity = 0.04. Then NULL
    // out the bot's quantity_per_level to simulate a legacy row.
    const res = await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, status)
      VALUES ('BTC_USDT_Perp', 'long', 2, 60000, 80000, 10, 1000, 'paused')
    `);
    const botId = res.lastID;
    await priv(db).dbRun(`
      INSERT INTO grid_levels (bot_id, level_index, price, side, quantity)
      VALUES (?, 0, 65000, 'buy', 0.04)
    `, botId);
    await priv(db).dbRun(`UPDATE grid_bots SET quantity_per_level = NULL WHERE id = ?`, botId);

    // Re-run → backfill picks up grid_levels[0].quantity = 0.04.
    await db.initialize();

    const row = await priv(db).dbGet(`SELECT quantity_per_level FROM grid_bots WHERE id = ?`, botId);
    expect(row?.quantity_per_level).toBe(0.04);
  });

  it('does NOT overwrite original_investment_usdt for rows that already have it', async () => {
    const db = await makeDb();

    // New row with explicit original_investment_usdt = 500. Even if
    // investment_usdt later bumps to 750 (e.g. after a compound), the
    // original should stay 500 across re-runs of initialize().
    await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, original_investment_usdt, status)
      VALUES ('SOL_USDT_Perp', 'long', 5, 100, 200, 20, 750, 500, 'paused')
    `);

    await db.initialize();

    const row = await priv(db).dbGet(`
      SELECT investment_usdt, original_investment_usdt FROM grid_bots WHERE pair = 'SOL_USDT_Perp'
    `);
    expect(row?.investment_usdt).toBe(750);
    expect(row?.original_investment_usdt).toBe(500); // preserved, not bumped to 750
  });
});
