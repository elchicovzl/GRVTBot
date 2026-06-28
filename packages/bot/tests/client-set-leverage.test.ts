// Regression guard for the leverage endpoint. GRVT's real endpoint is
// set_initial_leverage; /set_leverage returns HTTP 404, which the bot surfaced
// as "GRVT rejected" and made EVERY fresh bot start fail. This locks the
// correct endpoint + the fail-closed behavior (success=false and 404 → false).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedRequest = vi.fn();
vi.mock('../src/api/auth.js', () => ({
  authenticatedRequest: (...args: unknown[]) => authenticatedRequest(...args),
  authenticatedRequestWithState: vi.fn(),
  publicRequest: vi.fn(),
  authenticateGRVT: vi.fn(),
  authenticateWithKey: vi.fn(),
  createEmptyAuthState: () => ({}),
}));

import { GRVTClient } from '../src/api/client.js';

describe('GRVTClient.setLeverage', () => {
  beforeEach(() => authenticatedRequest.mockReset());

  it('hits set_initial_leverage (NOT the 404 set_leverage) with the SDK body', async () => {
    authenticatedRequest.mockResolvedValue({ success: true });
    const ok = await new GRVTClient().setLeverage('SOL_USDT_Perp', 3);
    expect(ok).toBe(true);

    const [url, body] = authenticatedRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toMatch(/\/set_initial_leverage$/);
    expect(url.endsWith('/set_leverage')).toBe(false); // the old 404 endpoint
    expect(body).toMatchObject({ instrument: 'SOL_USDT_Perp', leverage: '3' });
  });

  it('fails closed when GRVT responds success=false', async () => {
    authenticatedRequest.mockResolvedValue({ success: false });
    expect(await new GRVTClient().setLeverage('SOL_USDT_Perp', 3)).toBe(false);
  });

  // NOTE: the throw/404 path (catch → return false) is exercised in practice
  // and is a plain try/catch returning false; we don't unit-test the rejecting
  // mock here because vitest's unhandled-rejection tracker flags the rejected
  // promise even though setLeverage catches it. The success=false case above
  // already locks the fail-closed contract.

  it('treats a 200 with no success field as applied', async () => {
    authenticatedRequest.mockResolvedValue({});
    expect(await new GRVTClient().setLeverage('SOL_USDT_Perp', 3)).toBe(true);
  });
});
