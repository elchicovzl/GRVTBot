// G.3 — Smoke test for scripts/backup.sh. Skipped entirely when the
// sqlite3 CLI is not installed (CI images without it, etc.) — the
// script itself refuses to run without it (exit 2) by design.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/backup.sh'
);

const hasSqlite3 = (() => {
  try {
    execSync('command -v sqlite3', { shell: '/bin/bash', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasSqlite3)('scripts/backup.sh (G.3)', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grvt-backup-test-'));
    dbPath = path.join(tmpDir, 'grid_bot.db');
    backupDir = path.join(tmpDir, 'backups');
    execFileSync('sqlite3', [
      dbPath,
      'PRAGMA journal_mode=WAL; CREATE TABLE grid_bots(id INTEGER PRIMARY KEY, pair TEXT); INSERT INTO grid_bots(pair) VALUES (\'ETH_USDT_Perp\');',
    ]);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a timestamped, gzipped, integrity-checked backup', () => {
    const out = execFileSync('bash', [SCRIPT], {
      env: { ...process.env, GRID_BOT_DB: dbPath, BACKUP_DIR: backupDir },
      encoding: 'utf8',
    });
    expect(out).toContain('backup ok');

    const dirs = fs.readdirSync(backupDir).filter((d) => /^\d{8}_\d{6}$/.test(d));
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    const file = path.join(backupDir, dirs[0]!, 'grid_bot.db.gz');
    expect(fs.existsSync(file)).toBe(true);

    // The restored copy must be a valid SQLite db with our data.
    const restored = path.join(tmpDir, 'restored.db');
    execSync(`gunzip -c '${file}' > '${restored}'`, { shell: '/bin/bash' });
    const check = execFileSync('sqlite3', [restored, 'PRAGMA integrity_check;'], {
      encoding: 'utf8',
    }).trim();
    expect(check).toBe('ok');
    const rows = execFileSync('sqlite3', [restored, 'SELECT pair FROM grid_bots;'], {
      encoding: 'utf8',
    }).trim();
    expect(rows).toBe('ETH_USDT_Perp');
  });

  it('exits 3 when the source database does not exist', () => {
    let status = 0;
    try {
      execFileSync('bash', [SCRIPT], {
        env: {
          ...process.env,
          GRID_BOT_DB: path.join(tmpDir, 'missing.db'),
          BACKUP_DIR: backupDir,
        },
        stdio: 'pipe',
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    }
    expect(status).toBe(3);
  });
});
