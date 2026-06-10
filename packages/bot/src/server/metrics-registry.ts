// G.5 — In-memory per-bot monitor metrics registry.
//
// The grid engine WRITES here (one recordTick per bot per monitor pass,
// one recordError per classified failure) and the /api/v2/metrics
// endpoint READS via renderPrometheus(). Deliberately dependency-free
// (no prom-client) and allocation-light: two Maps and an integer.
//
// This module must not import anything from the engine or the router —
// it sits between them and both import it (no cycles).

import fs from 'node:fs';

/** Monitor error classification for grvt_bot_errors_total{error_type=…}. */
export type MonitorErrorType =
  | 'safeguard'
  | 'margin'
  | 'api_timeout'
  | 'order_rejected'
  | 'other';

/** Ticks slower than this count as a stall (grvt_bot_tick_stalls_total). */
export const STALL_THRESHOLD_MS = 10_000;

interface TickRecord {
  pair: string;
  durationMs: number;
  at: number;
}

/**
 * Classify a monitor-loop error into a small label set. Order matters:
 * the engine's structured SAFEGUARD:/MARGIN: throws are checked first
 * because their messages can ALSO contain words like "rejected".
 */
export function classifyMonitorError(err: unknown): MonitorErrorType {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (msg.includes('SAFEGUARD')) return 'safeguard';
  if (msg.includes('MARGIN:')) return 'margin';
  if (
    /timed?[\s_-]?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|aborted|network/i.test(
      msg
    )
  ) {
    return 'api_timeout';
  }
  if (/reject|insufficient|denied|invalid order|order.*cancel.*fail/i.test(msg)) {
    return 'order_rejected';
  }
  return 'other';
}

class BotMetricsRegistry {
  /** botId → last monitor tick (duration gauge). */
  private lastTicks = new Map<number, TickRecord>();
  /** Ticks that exceeded STALL_THRESHOLD_MS since process start. */
  private stallsTotal = 0;
  /** `${botId}|${errorType}` → count since process start. */
  private errorCounts = new Map<string, number>();

  recordTick(botId: number, pair: string, durationMs: number): void {
    this.lastTicks.set(botId, { pair, durationMs, at: Date.now() });
    if (durationMs > STALL_THRESHOLD_MS) this.stallsTotal++;
  }

  recordError(botId: number, errorType: MonitorErrorType): void {
    const key = `${botId}|${errorType}`;
    this.errorCounts.set(key, (this.errorCounts.get(key) ?? 0) + 1);
  }

  /** Drop gauges for a bot that no longer exists (optional housekeeping). */
  forgetBot(botId: number): void {
    this.lastTicks.delete(botId);
  }

  getLastTick(botId: number): TickRecord | undefined {
    return this.lastTicks.get(botId);
  }

  getStallsTotal(): number {
    return this.stallsTotal;
  }

  getErrorCount(botId: number, errorType: MonitorErrorType): number {
    return this.errorCounts.get(`${botId}|${errorType}`) ?? 0;
  }

  /** Prometheus text-format lines for the /metrics endpoint. */
  renderPrometheus(): string[] {
    const lines: string[] = [
      '# HELP grvt_bot_tick_duration_ms Duration of the last monitor tick per bot',
      '# TYPE grvt_bot_tick_duration_ms gauge',
    ];
    for (const [botId, tick] of this.lastTicks) {
      lines.push(
        `grvt_bot_tick_duration_ms{bot_id="${botId}",pair="${tick.pair}"} ${tick.durationMs}`
      );
    }
    lines.push(
      '# HELP grvt_bot_tick_stalls_total Monitor ticks that exceeded the 10s stall threshold',
      '# TYPE grvt_bot_tick_stalls_total counter',
      `grvt_bot_tick_stalls_total ${this.stallsTotal}`,
      '# HELP grvt_bot_errors_total Monitor errors per bot by classified type',
      '# TYPE grvt_bot_errors_total counter'
    );
    for (const [key, count] of this.errorCounts) {
      const [botId, errorType] = key.split('|');
      lines.push(
        `grvt_bot_errors_total{bot_id="${botId}",error_type="${errorType}"} ${count}`
      );
    }
    return lines;
  }

  /** Test hook — clears all state. */
  reset(): void {
    this.lastTicks.clear();
    this.errorCounts.clear();
    this.stallsTotal = 0;
  }
}

/** Process-wide singleton. Engine writes, router reads. */
export const botMetrics = new BotMetricsRegistry();

/**
 * Size of the SQLite -wal file in bytes (0 if absent, e.g. :memory: or
 * right after a TRUNCATE checkpoint). Used for grvt_sqlite_wal_size_bytes
 * and by the WAL checkpoint guard.
 */
export function walSizeBytes(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}
