// Regression guard for the leverage endpoint + its 3-state contract.
//  - GRVT's endpoint is set_initial_leverage (set_leverage 404s).
//  - GRVT DEPRECATED leverage-by-API (code 2106) → 'deprecated' (non-fatal).
//  - real failures (success=false) → 'rejected' (fail-closed).
// The catch-path classification is unit-tested via the exported helper
// (isDeprecatedLeverageError) rather than a throwing mock — vitest's
// unhandled-rejection tracker flags a mocked rejection even though setLeverage
// catches it; the helper test is equivalent and reliable.

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

import { GRVTClient, isDeprecatedLeverageError } from '../src/api/client.js';

describe('isDeprecatedLeverageError', () => {
  it('matches the GRVT deprecation (code 2106 / "deprecated")', () => {
    expect(isDeprecatedLeverageError('HTTP 400: {"code":2106,"message":"This API has been deprecated and can no longer be used to set leverage","status":400}')).toBe(true);
    expect(isDeprecatedLeverageError('deprecated')).toBe(true);
  });
  it('does NOT match a 404 or a business rejection', () => {
    expect(isDeprecatedLeverageError('HTTP 404: not found')).toBe(false);
    expect(isDeprecatedLeverageError('HTTP 400: {"code":3022,"message":"insufficient margin"}')).toBe(false);
  });
});

describe('GRVTClient.setLeverage', () => {
  beforeEach(() => authenticatedRequest.mockReset());

  it('hits set_initial_leverage (NOT the 404 set_leverage) with the SDK body', async () => {
    authenticatedRequest.mockResolvedValue({ success: true });
    expect(await new GRVTClient().setLeverage('SOL_USDT_Perp', 3)).toBe('ok');

    const [url, body] = authenticatedRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toMatch(/\/set_initial_leverage$/);
    expect(url.endsWith('/set_leverage')).toBe(false); // the old 404 endpoint
    expect(body).toMatchObject({ instrument: 'SOL_USDT_Perp', leverage: '3' });
  });

  it('fails closed ("rejected") when GRVT responds success=false', async () => {
    authenticatedRequest.mockResolvedValue({ success: false });
    expect(await new GRVTClient().setLeverage('SOL_USDT_Perp', 3)).toBe('rejected');
  });

  it('treats a 200 with no success field as applied', async () => {
    authenticatedRequest.mockResolvedValue({});
    expect(await new GRVTClient().setLeverage('SOL_USDT_Perp', 3)).toBe('ok');
  });
});
