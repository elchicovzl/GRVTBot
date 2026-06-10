// Tests for per-user rate buckets, ticker coalescing and 429 backoff
// in packages/bot/src/api/client.ts.
//
// All network is mocked at the auth-module boundary (the same seam the
// client uses), so these tests exercise the real RateLimiter / coalesce /
// backoff code paths with vi fake timers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const authMocks = vi.hoisted(() => ({
  authenticatedRequest: vi.fn(),
  authenticatedRequestWithState: vi.fn(),
  publicRequest: vi.fn(),
  authenticateGRVT: vi.fn(),
  authenticateWithKey: vi.fn(),
}));

vi.mock('../src/api/auth.js', () => ({
  ...authMocks,
  createEmptyAuthState: () => ({
    gravityCookie: '',
    accountId: '',
    isAuthenticated: false,
    expiresAt: 0,
    loginTime: 0,
  }),
}));

import {
  GRVTClient,
  __resetRateBucketsForTests,
  __resetCoalesceForTests,
  type GrvtClientCreds,
} from '../src/api/client.js';

function makeCreds(accountId: string, apiKey = `key-${accountId}`): GrvtClientCreds {
  return {
    apiKey,
    apiSecret: '0x' + '11'.repeat(32),
    tradingAddress: '0x' + 'ab'.repeat(20),
    accountId,
    subAccountId: `sub-${accountId}`,
  };
}

describe('per-user rate limiting + coalescing + 429 backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetRateBucketsForTests();
    __resetCoalesceForTests();
    authMocks.authenticatedRequestWithState.mockResolvedValue([]);
    authMocks.publicRequest.mockResolvedValue({ instrument: 'BTC_USDT_Perp', last_price: '100000' });
    // Mock long-lived auth so re-auth never fires inside the mocked seam.
    authMocks.authenticateWithKey.mockResolvedValue(true);
    authMocks.authenticateGRVT.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('per-user rate buckets', () => {
    it('user B is NOT delayed by user A exhausting their bucket', async () => {
      const userA = new GRVTClient(makeCreds('account-A'));
      const userB = new GRVTClient(makeCreds('account-B'));

      // Burst: user A fills their 10 req/s bucket (no waits — bucket empty).
      await Promise.all(
        Array.from({ length: 10 }, () => userA.getOpenOrders())
      );

      // 11th request from A must wait on A's bucket...
      let aResolved = false;
      let bResolved = false;
      const aPromise = userA.getOpenOrders().then(() => { aResolved = true; });
      // ...but B's first request goes through immediately (separate bucket).
      const bPromise = userB.getOpenOrders().then(() => { bResolved = true; });

      await vi.advanceTimersByTimeAsync(0);
      expect(bResolved).toBe(true);
      expect(aResolved).toBe(false);

      // A's 11th resolves only after the 1s window (+50ms safety) elapses.
      await vi.advanceTimersByTimeAsync(1100);
      expect(aResolved).toBe(true);

      await Promise.all([aPromise, bPromise]);
    });

    it("multiple clients of the SAME user share one bucket", async () => {
      // Same accountId, different api keys / clients — quota is per account.
      const clientA1 = new GRVTClient(makeCreds('account-A', 'key-1'));
      const clientA2 = new GRVTClient(makeCreds('account-A', 'key-2'));

      await Promise.all(
        Array.from({ length: 10 }, () => clientA1.getOpenOrders())
      );

      // clientA2's first request lands in the SAME (full) bucket → delayed.
      let resolved = false;
      const p = clientA2.getOpenOrders().then(() => { resolved = true; });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1100);
      expect(resolved).toBe(true);
      await p;
    });
  });

  describe('getTicker coalescing', () => {
    it('N concurrent getTicker calls for the same instrument issue 1 request', async () => {
      const userA = new GRVTClient(makeCreds('account-A'));
      const userB = new GRVTClient(makeCreds('account-B'));

      const results = await Promise.all([
        userA.getTicker('BTC_USDT_Perp'),
        userA.getTicker('BTC_USDT_Perp'),
        userB.getTicker('BTC_USDT_Perp'),
        userB.getTicker('BTC_USDT_Perp'),
        userA.getTicker('BTC_USDT_Perp'),
      ]);

      expect(authMocks.publicRequest).toHaveBeenCalledTimes(1);
      for (const r of results) {
        expect(r).toEqual({ instrument: 'BTC_USDT_Perp', last_price: '100000' });
      }
    });

    it('different instruments do NOT share a coalesce key', async () => {
      const client = new GRVTClient(makeCreds('account-A'));

      await Promise.all([
        client.getTicker('BTC_USDT_Perp'),
        client.getTicker('ETH_USDT_Perp'),
      ]);

      expect(authMocks.publicRequest).toHaveBeenCalledTimes(2);
    });

    it('refetches after the ~1s TTL expires', async () => {
      const client = new GRVTClient(makeCreds('account-A'));

      await client.getTicker('BTC_USDT_Perp');
      // Within TTL → served from cache, no new request.
      await client.getTicker('BTC_USDT_Perp');
      expect(authMocks.publicRequest).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1100);
      await client.getTicker('BTC_USDT_Perp');
      expect(authMocks.publicRequest).toHaveBeenCalledTimes(2);
    });

    it('a failed fetch is not cached — next caller retries fresh', async () => {
      const client = new GRVTClient(makeCreds('account-A'));
      authMocks.publicRequest.mockRejectedValueOnce(new Error('HTTP 500: boom'));

      await expect(client.getTicker('BTC_USDT_Perp')).rejects.toThrow('HTTP 500');

      await client.getTicker('BTC_USDT_Perp');
      expect(authMocks.publicRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('429 backoff with jitter', () => {
    it('backs off on 429 and succeeds on retry', async () => {
      const client = new GRVTClient(makeCreds('account-A'));
      authMocks.authenticatedRequestWithState
        .mockRejectedValueOnce(new Error('HTTP 429: {"code":1003,"message":"RATE_LIMITED"}'))
        .mockResolvedValueOnce([{ order_id: 'o-1', instrument: 'BTC_USDT_Perp' }]);

      let result: unknown;
      const p = client.getOpenOrders('BTC_USDT_Perp').then(r => { result = r; });

      // First attempt fires and fails; retry is parked behind a backoff timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(authMocks.authenticatedRequestWithState).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();

      // First backoff window is 250–500ms (equal jitter on a 500ms base).
      await vi.advanceTimersByTimeAsync(600);
      await p;

      expect(authMocks.authenticatedRequestWithState).toHaveBeenCalledTimes(2);
      expect(result).toEqual([{ order_id: 'o-1', instrument: 'BTC_USDT_Perp' }]);
      // Surfaced a contextual warning (user + endpoint).
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('429')
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('endpoint=open_orders')
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('sub-account-A')
      );
    });

    it('gives up after max retries and rethrows the 429', async () => {
      const client = new GRVTClient(makeCreds('account-A'));
      authMocks.authenticatedRequestWithState.mockRejectedValue(
        new Error('HTTP 429: still limited')
      );

      let error: Error | undefined;
      const p = client.getOpenOrders().catch((e: Error) => { error = e; });

      // Enough time for all backoff windows (500+1000+2000ms max, jittered).
      await vi.advanceTimersByTimeAsync(10_000);
      await p;

      expect(error?.message).toContain('HTTP 429');
      // 1 initial attempt + 3 retries.
      expect(authMocks.authenticatedRequestWithState).toHaveBeenCalledTimes(4);
    });

    it('does NOT retry non-429 errors', async () => {
      const client = new GRVTClient(makeCreds('account-A'));
      authMocks.authenticatedRequestWithState.mockRejectedValue(
        new Error('HTTP 500: internal error')
      );

      await expect(client.getOpenOrders()).rejects.toThrow('HTTP 500');
      expect(authMocks.authenticatedRequestWithState).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry app-level 429/2090 (max open orders exceeded)', async () => {
      const client = new GRVTClient(makeCreds('account-A'));
      authMocks.authenticatedRequestWithState.mockRejectedValue(
        new Error('HTTP 429: {"code":2090,"message":"Max open orders exceeded"}')
      );

      await expect(client.getOpenOrders()).rejects.toThrow('2090');
      expect(authMocks.authenticatedRequestWithState).toHaveBeenCalledTimes(1);
    });
  });
});
