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
  type DailyPnlResponse,
  type DailySnapshot,
  type FeeSummary,
  type FillRow,
  type FundingRow,
  type GridState,
  type HealthV2,
  type BacktestInput,
  type BacktestResult,
  type OrderRow,
  type PortfolioEquityPoint,
  type PortfolioSummary,
  type RangeUpdatePlan,
  type RealizedSummary,
  type RebateSummary,
  type Roundtrip,
  type Trade,
  type ValidateBotInput,
  type ValidateBotResult,
} from './api-types';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
// Legacy API key — kept as fallback during migration so the
// dashboard keeps working before the user logs in for the first time.
const LEGACY_API_KEY = import.meta.env.VITE_DASHBOARD_API_KEY ?? '';

// JWT token set by AuthProvider via setAuthToken(). Stored in a module
// var so the request() helper reads the current value on every call
// without needing React context.
let jwtToken: string | null = null;
export function setAuthToken(token: string) { jwtToken = token; }
export function clearAuthToken() { jwtToken = null; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}/api/v2${path}`;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');

  // Prefer JWT. Fall back to legacy X-Api-Key if no token yet
  // (first visit before login).
  if (jwtToken) {
    headers.set('Authorization', `Bearer ${jwtToken}`);
  } else if (LEGACY_API_KEY) {
    headers.set('X-Api-Key', LEGACY_API_KEY);
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
    // On 401, dispatch a logout event so AuthProvider clears state
    // and redirects to /login. Only fire if we had a token (avoid
    // infinite loops on public pages).
    if (response.status === 401 && jwtToken) {
      window.dispatchEvent(new Event('auth:logout'));
    }
    const message =
      (payload as { error?: string; message?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      `HTTP ${response.status}`;
    throw new ApiError(response.status, payload, message);
  }

  return payload as T;
}

// ── Public auth requests (no token needed) ────────────────────────────
async function publicRequest<T>(path: string, body: object): Promise<T> {
  const url = `${BASE_URL}/api/v2${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = (payload as { message?: string; error?: string } | null)?.message
      ?? (payload as { error?: string } | null)?.error
      ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, payload, msg);
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

  // F4.4: maker/taker/rebate fee breakdown from real GRVT fills.
  getFeeSummary: (id: number) =>
    request<FeeSummary>(`/bots/${id}/fee-summary`),

  // F4.4: per-day PnL deltas for the daily bar chart (30 days default).
  getDailyPnl: (id: number, days = 30) =>
    request<DailyPnlResponse>(`/bots/${id}/daily-pnl?days=${days}`),

  // H.7: portfolio-level aggregates across all user bots.
  getPortfolioSummary: () =>
    request<PortfolioSummary>('/portfolio-summary'),

  getPortfolioEquityCurve: (days = 90) =>
    request<{ points: PortfolioEquityPoint[] }>(
      `/portfolio-equity-curve?days=${days}`
    ),

  // H.6: pure simulation against historical GRVT candles. The result's
  // equityCurve is already thinned server-side to ~200 points.
  runBacktest: (input: BacktestInput) =>
    request<BacktestResult>('/backtest', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

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

  updateRisk: (
    id: number,
    body: { sl_pct?: number | null; tp_pct?: number | null }
  ) =>
    request<{ id: number; sl_pct?: number | null; tp_pct?: number | null }>(
      `/bots/${id}/risk`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      }
    ),

  updateCompound: (
    id: number,
    body: {
      compound_pct: number;
      compound_threshold_usdt?: number;
      compound_interval_hours?: number;
    }
  ) =>
    request<{ id: number; compound_pct: number }>(`/bots/${id}/compound`, {
      method: 'PATCH',
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

  // ── Auth endpoints ──────────────────────────────────────────────

  signup: (email: string, password: string, tosLang: 'es' | 'en' = 'en') =>
    publicRequest<{
      token: string;
      userId: number;
      isAdmin: boolean;
      hasGrvtCreds: boolean;
    }>('/auth/signup', { email, password, terms_lang: tosLang }),

  login: (email: string, password: string) =>
    publicRequest<{
      token: string;
      userId: number;
      isAdmin: boolean;
      hasGrvtCreds: boolean;
    }>('/auth/login', { email, password }),

  forgotPassword: (email: string) =>
    publicRequest<{ ok: true }>('/auth/forgot-password', { email }),

  resetPassword: (token: string, newPassword: string) =>
    publicRequest<{ ok: true }>('/auth/reset-password', {
      token,
      new_password: newPassword,
    }),

  getMe: () =>
    request<{
      id: number;
      email: string;
      isAdmin: boolean;
      hasGrvtCreds: boolean;
      createdAt: number;
      lastLoginAt: number | null;
    }>('/auth/me'),

  getTos: () =>
    request<{
      version: string;
      text: string;
      texts?: { en: string; es: string };
    }>('/auth/tos'),

  saveGrvtCredentials: (body: {
    apiKey: string;
    apiSecret: string;
    tradingAddress: string;
    accountId: string;
    // Optional: when empty the server defaults to accountId.
    subAccountId?: string;
  }) =>
    request<{ ok: true }>('/auth/grvt-credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteGrvtCredentials: () =>
    request<{ ok: true }>('/auth/grvt-credentials', {
      method: 'DELETE',
    }),

  // H.5: GRVT sub-accounts. The default credentials live elsewhere
  // (saveGrvtCredentials above); these manage extras with a label.
  listSubAccounts: () =>
    request<Array<{
      id: number;
      label: string;
      isDefault: boolean;
      lastTestOk: boolean | null;
      createdAt: number;
    }>>('/auth/grvt-sub-accounts'),

  createSubAccount: (body: {
    label: string;
    apiKey: string;
    apiSecret: string;
    tradingAddress: string;
    accountId: string;
    // Optional: when empty the server defaults to accountId.
    subAccountId?: string;
    isDefault?: boolean;
  }) =>
    request<{
      id: number;
      label: string;
      isDefault: boolean;
      equity: string | null;
    }>('/auth/grvt-sub-accounts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateSubAccount: (
    id: number,
    body: { label?: string; isDefault?: boolean }
  ) =>
    request<{ ok: true }>(`/auth/grvt-sub-accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteSubAccount: (id: number) =>
    request<{ ok: true }>(`/auth/grvt-sub-accounts/${id}`, {
      method: 'DELETE',
    }),
};
