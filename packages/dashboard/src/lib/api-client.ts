// REST client for the v2 dashboard API.
//
// In dev, VITE_API_BASE_URL is empty/"" so requests go to "/api/v2/..." and
// the Vite proxy in vite.config.ts forwards to the backend. In prod build,
// the same paths are served from the same origin (no proxy needed).
// To point at a remote backend (e.g. for staging UI hitting prod data),
// set VITE_API_BASE_URL to a full origin like "https://grvt-grid.example.com".

import {
  ApiError,
  type BotSummary,
  type Candle,
  type CandleInterval,
  type DailySnapshot,
  type FillRow,
  type FundingRow,
  type GridState,
  type HealthV2,
  type OrderRow,
  type RangeUpdatePlan,
  type RealizedSummary,
  type RebateSummary,
  type Roundtrip,
  type Trade,
  type ValidateBotInput,
  type ValidateBotResult,
} from './api-types';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const API_KEY = import.meta.env.VITE_DASHBOARD_API_KEY ?? '';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}/api/v2${path}`;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (API_KEY) {
    headers.set('X-Api-Key', API_KEY);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    throw new ApiError(0, null, `network error: ${(cause as Error).message}`);
  }

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const message =
      (payload as { error?: string; message?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      `HTTP ${response.status}`;
    throw new ApiError(response.status, payload, message);
  }

  return payload as T;
}

// ── Endpoints ───────────────────────────────────────────────────────────

export const api = {
  getHealth: () => request<HealthV2>('/health'),

  getBots: () => request<{ bots: BotSummary[] }>('/bots'),
  getBot: (id: number) => request<{ bot: BotSummary }>(`/bots/${id}`),
  getGridState: (id: number) => request<GridState>(`/bots/${id}/grid-state`),

  getInstruments: () => request<{ instruments: unknown[] }>('/instruments'),
  getBalance: () => request<{ balance: unknown }>('/balance'),

  getTrades: (id: number, opts: { limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ trades: Trade[] }>(`/bots/${id}/trades${suffix}`);
  },

  getSnapshots: (id: number) =>
    request<{ snapshots: DailySnapshot[] }>(`/bots/${id}/snapshots`),

  getRoundtrips: (id: number) =>
    request<{ roundtrips: Roundtrip[]; count: number; totalProfit: number }>(
      `/bots/${id}/roundtrips`
    ),

  // Real fills from the actively-populated fills_archive table. Source
  // is GRVT fill_history — every fee is what the exchange actually
  // charged or refunded on this account.
  getFills: (id: number, opts: { limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ fills: FillRow[] }>(`/bots/${id}/fills${suffix}`);
  },

  getRebateSummary: (id: number) =>
    request<RebateSummary>(`/bots/${id}/rebate-summary`),

  getRealizedSummary: (id: number) =>
    request<RealizedSummary>(`/bots/${id}/realized-summary`),

  getOrders: (
    id: number,
    opts: { status?: 'all' | 'pending' | 'filled' | 'cancelled' | 'rejected'; limit?: number } = {}
  ) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ orders: OrderRow[]; degraded?: boolean; hint?: string }>(
      `/bots/${id}/orders${suffix}`
    );
  },

  getFunding: (id: number, opts: { limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{
      funding: FundingRow[];
      count: number;
      totalPaymentUsdt: number;
    }>(`/bots/${id}/funding${suffix}`);
  },

  validateBot: (input: ValidateBotInput) =>
    request<ValidateBotResult>('/bots/validate', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Mutations — these touch real money. The wizard "Create" button calls
  // createBot (status='paused'); the user must explicitly start it from
  // the bot detail page after reviewing the bot in the UI.
  createBot: (input: ValidateBotInput) =>
    request<{ id: number; status: 'paused' }>('/bots', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  startBot: (id: number) =>
    request<{ id: number; status: 'running' }>(`/bots/${id}/start`, {
      method: 'POST',
    }),

  pauseBot: (id: number) =>
    request<{ id: number; status: 'paused' }>(`/bots/${id}/pause`, {
      method: 'POST',
    }),

  // Final stop. Cancels every open order AND market-closes the open
  // position with a 0.5% aggressive GTC limit. Bot status flips to
  // 'stopped' — it stays in the DB for history but no longer counts
  // as an active bot. Differs from pauseBot which only cancels orders
  // and leaves the position open for later resume.
  closeBot: (id: number) =>
    request<{ id: number; status: 'stopped' }>(`/bots/${id}/close`, {
      method: 'POST',
    }),

  // Read-only dry-run of a range update. Returns the full plan
  // (orders to cancel, levels to create, ETH to auto-buy with cost
  // estimate, warnings, safety violations) WITHOUT executing anything.
  // The dialog calls this on every input change for live preview.
  previewBotRangeUpdate: (
    id: number,
    body: { lowerPrice: number; upperPrice: number }
  ) =>
    request<{ plan: RangeUpdatePlan }>(`/bots/${id}/range/preview`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Commit a range update. The engine re-runs the same plan-builder
  // server-side, so the user is committing exactly what they saw in
  // preview. Refuses on safety violations; short-circuits on no-op.
  // Atomic: per-bot mutex held for the duration so monitor() cannot
  // race against the mutation.
  updateBotRange: (
    id: number,
    body: { lowerPrice: number; upperPrice: number }
  ) =>
    request<{
      id: number;
      lowerPrice: number;
      upperPrice: number;
      numGrids: number;
    }>(`/bots/${id}/range`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getCandles: (
    pair: string,
    interval: CandleInterval = 'CI_1_H',
    limit = 500
  ) => {
    const qs = new URLSearchParams({
      pair,
      interval,
      limit: String(limit),
    });
    return request<{ pair: string; interval: string; candles: Candle[] }>(
      `/candles?${qs.toString()}`
    );
  },
};
