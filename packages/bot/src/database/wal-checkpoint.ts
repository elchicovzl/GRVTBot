// G.5 — Periodic WAL checkpoint guard.
//
// SQLite in WAL mode auto-checkpoints at ~4MB (1000 pages), but a
// long-lived reader (a slow SELECT, a backup, the dashboard pollers)
// can prevent checkpoints from completing, and the -wal file then grows
// without bound — we have seen multi-GB WALs take down small VPSes.
//
// This guard stats the -wal file every `intervalMs` and, when it exceeds
// GRVT_WAL_CHECKPOINT_MB (default 100), runs PRAGMA wal_checkpoint(RESTART)
// and logs the duration + result. RESTART (not TRUNCATE) is chosen on
// purpose: it guarantees the next writer restarts the WAL from frame 0
// without the extra I/O of truncating the file while the bot is trading.

import { childLogger } from '../server/logger.js';
import { walSizeBytes } from '../server/metrics-registry.js';
import type { GridBotDB } from './db.js';

const log = childLogger('wal-checkpoint');

const DEFAULT_THRESHOLD_MB = 100;
const DEFAULT_INTERVAL_MS = 60_000;

/** Env-configurable threshold in bytes (GRVT_WAL_CHECKPOINT_MB, default 100). */
export function walCheckpointThresholdBytes(): number {
  const mb = Number(process.env.GRVT_WAL_CHECKPOINT_MB);
  const effective = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_THRESHOLD_MB;
  return effective * 1024 * 1024;
}

export interface WalCheckpointGuard {
  stop(): void;
  /** Run one check immediately (also what the timer calls). Exposed for tests. */
  checkNow(): Promise<{ checkpointed: boolean; walBytes: number }>;
}

export function startWalCheckpointGuard(
  db: GridBotDB,
  opts: { intervalMs?: number } = {}
): WalCheckpointGuard {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const checkNow = async (): Promise<{ checkpointed: boolean; walBytes: number }> => {
    const walBytes = walSizeBytes(db.getDbPath());
    const thresholdBytes = walCheckpointThresholdBytes();
    if (walBytes <= thresholdBytes) {
      return { checkpointed: false, walBytes };
    }
    const start = Date.now();
    try {
      const result = await db.walCheckpoint('RESTART');
      const durationMs = Date.now() - start;
      const after = walSizeBytes(db.getDbPath());
      if (result?.busy) {
        // A long-lived reader blocked the checkpoint — the WAL will keep
        // growing until that reader finishes. Warn loudly so the operator
        // can find the offender instead of discovering a full disk.
        log.warn(
          { walBytes, thresholdBytes, durationMs, result },
          'wal_checkpoint(RESTART) was BLOCKED by an active reader — WAL not reset'
        );
      } else {
        log.info(
          { walBytes, walBytesAfter: after, thresholdBytes, durationMs, result },
          'WAL exceeded threshold — wal_checkpoint(RESTART) completed'
        );
      }
      return { checkpointed: true, walBytes };
    } catch (err) {
      log.error(
        { err: (err as Error).message, walBytes, durationMs: Date.now() - start },
        'wal_checkpoint(RESTART) failed'
      );
      return { checkpointed: false, walBytes };
    }
  };

  const timer = setInterval(() => {
    void checkNow();
  }, intervalMs);
  // Don't keep the process alive just for housekeeping.
  timer.unref?.();

  log.info(
    { intervalMs, thresholdBytes: walCheckpointThresholdBytes() },
    'WAL checkpoint guard started'
  );

  return {
    stop: () => clearInterval(timer),
    checkNow,
  };
}
