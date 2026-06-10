// G.5 — Metrics registry unit tests: tick gauge math, stall counting,
// error classification/counters, and Prometheus rendering.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  botMetrics,
  classifyMonitorError,
  walSizeBytes,
  STALL_THRESHOLD_MS,
} from '../src/server/metrics-registry.js';

beforeEach(() => {
  botMetrics.reset();
});

describe('botMetrics.recordTick', () => {
  it('stores the last tick duration per bot (gauge semantics — overwrites)', () => {
    botMetrics.recordTick(1, 'ETH_USDT_Perp', 120);
    botMetrics.recordTick(1, 'ETH_USDT_Perp', 45);
    expect(botMetrics.getLastTick(1)?.durationMs).toBe(45);
    expect(botMetrics.getLastTick(1)?.pair).toBe('ETH_USDT_Perp');
  });

  it('tracks bots independently', () => {
    botMetrics.recordTick(1, 'ETH_USDT_Perp', 100);
    botMetrics.recordTick(2, 'BTC_USDT_Perp', 200);
    expect(botMetrics.getLastTick(1)?.durationMs).toBe(100);
    expect(botMetrics.getLastTick(2)?.durationMs).toBe(200);
  });

  it('counts ticks above the 10s threshold as stalls', () => {
    botMetrics.recordTick(1, 'ETH_USDT_Perp', STALL_THRESHOLD_MS); // boundary — NOT a stall
    expect(botMetrics.getStallsTotal()).toBe(0);
    botMetrics.recordTick(1, 'ETH_USDT_Perp', STALL_THRESHOLD_MS + 1);
    botMetrics.recordTick(2, 'BTC_USDT_Perp', 30_000);
    expect(botMetrics.getStallsTotal()).toBe(2);
  });

  it('forgetBot drops the gauge but keeps the cumulative stall counter', () => {
    botMetrics.recordTick(1, 'ETH_USDT_Perp', 30_000);
    botMetrics.forgetBot(1);
    expect(botMetrics.getLastTick(1)).toBeUndefined();
    expect(botMetrics.getStallsTotal()).toBe(1);
  });
});

describe('botMetrics.recordError', () => {
  it('increments per (bot, type) counters independently', () => {
    botMetrics.recordError(1, 'safeguard');
    botMetrics.recordError(1, 'safeguard');
    botMetrics.recordError(1, 'api_timeout');
    botMetrics.recordError(2, 'safeguard');
    expect(botMetrics.getErrorCount(1, 'safeguard')).toBe(2);
    expect(botMetrics.getErrorCount(1, 'api_timeout')).toBe(1);
    expect(botMetrics.getErrorCount(2, 'safeguard')).toBe(1);
    expect(botMetrics.getErrorCount(2, 'margin')).toBe(0);
  });
});

describe('classifyMonitorError', () => {
  it('classifies the engine structured throws first', () => {
    expect(
      classifyMonitorError(new Error('SAFEGUARD:pause_close:bot=7:dist=1.2%:liq=1800:mark=1822'))
    ).toBe('safeguard');
    expect(
      classifyMonitorError(new Error('MARGIN:pause:bot=7:headroom=0.01'))
    ).toBe('margin');
  });

  it('SAFEGUARD wins even when the message also mentions rejection', () => {
    expect(classifyMonitorError(new Error('SAFEGUARD:pause: order rejected'))).toBe('safeguard');
  });

  it('classifies network/timeout failures as api_timeout', () => {
    expect(classifyMonitorError(new Error('request timed out after 10000ms'))).toBe('api_timeout');
    expect(classifyMonitorError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('api_timeout');
    expect(classifyMonitorError(new Error('socket hang up'))).toBe('api_timeout');
    expect(classifyMonitorError(new Error('read ECONNRESET'))).toBe('api_timeout');
  });

  it('classifies exchange rejections as order_rejected', () => {
    expect(classifyMonitorError(new Error('order rejected by GRVT'))).toBe('order_rejected');
    expect(classifyMonitorError(new Error('insufficient balance for order'))).toBe('order_rejected');
  });

  it('falls back to other (including non-Error values)', () => {
    expect(classifyMonitorError(new Error('something exploded'))).toBe('other');
    expect(classifyMonitorError('weird string throw')).toBe('other');
    expect(classifyMonitorError(undefined)).toBe('other');
  });
});

describe('botMetrics.renderPrometheus', () => {
  it('always emits HELP/TYPE headers and the stalls counter, even when empty', () => {
    const out = botMetrics.renderPrometheus().join('\n');
    expect(out).toContain('# TYPE grvt_bot_tick_duration_ms gauge');
    expect(out).toContain('# TYPE grvt_bot_tick_stalls_total counter');
    expect(out).toContain('# TYPE grvt_bot_errors_total counter');
    expect(out).toContain('grvt_bot_tick_stalls_total 0');
  });

  it('renders labeled series for ticks and errors', () => {
    botMetrics.recordTick(7, 'ETH_USDT_Perp', 123);
    botMetrics.recordTick(8, 'BTC_USDT_Perp', 11_000);
    botMetrics.recordError(7, 'margin');
    botMetrics.recordError(7, 'margin');

    const out = botMetrics.renderPrometheus().join('\n');
    expect(out).toContain('grvt_bot_tick_duration_ms{bot_id="7",pair="ETH_USDT_Perp"} 123');
    expect(out).toContain('grvt_bot_tick_duration_ms{bot_id="8",pair="BTC_USDT_Perp"} 11000');
    expect(out).toContain('grvt_bot_tick_stalls_total 1');
    expect(out).toContain('grvt_bot_errors_total{bot_id="7",error_type="margin"} 2');
  });
});

describe('walSizeBytes', () => {
  it('returns 0 when no -wal file exists (e.g. :memory: db)', () => {
    expect(walSizeBytes(':memory:')).toBe(0);
    expect(walSizeBytes('/definitely/not/a/real/path/grid_bot.db')).toBe(0);
  });
});
