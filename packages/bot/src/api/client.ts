// GRVT API Client - Fase 3
// Wrapper completo para todas las llamadas a GRVT
// Métodos: balance, positions, orders, fills, funding, leverage, etc.

import {
  authenticatedRequest,
  publicRequest,
  authenticateGRVT,
  authenticateWithKey,
  authenticatedRequestWithState,
  createEmptyAuthState,
} from './auth.js';
import { signOrder, formatSignedOrderForAPI } from './order-signer.js';
import dotenv from 'dotenv';

dotenv.config();

// Endpoints GRVT verificados por Marta
import { GRVT_MARKET_DATA_BASE_URL, GRVT_TRADING_BASE_URL } from './grvt-config.js';

const MARKET_DATA_URL = GRVT_MARKET_DATA_BASE_URL;
const TRADING_URL = GRVT_TRADING_BASE_URL;

// Tipos para las respuestas de la API
export interface Balance {
  sub_account_id: string;
  total_equity: string;
  available_balance: string;
  margin_used: string;
  maintenance_margin: string;
  initial_margin: string;
  currency: string;
}

export interface Position {
  sub_account_id: string;
  instrument: string;
  size: string;
  notional: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  side: 'buy' | 'sell';
  leverage: string;
  liquidation_price: string;
  margin_used: string;
  funding_payment: string;
}

export interface Order {
  order_id: string;
  sub_account_id: string;
  instrument: string;
  size: string;
  filled_size: string;
  price: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: 'open' | 'filled' | 'cancelled' | 'rejected';
  time_in_force: 'gtc' | 'ioc' | 'fok';
  created_time: number;
  updated_time: number;
  metadata?: string;
}

export interface Fill {
  fill_id: string;
  order_id: string;
  sub_account_id: string;
  instrument: string;
  size: string;
  price: string;
  side: 'buy' | 'sell';
  fee: string;
  fee_currency: string;
  liquidity: 'maker' | 'taker';
  created_time: number;
  trade_id: string;
  event_time?: string;
  is_buyer?: boolean;
  is_taker?: boolean;
  client_order_id?: string;
  realized_pnl?: string;
}

export interface CreateOrderRequest {
  sub_account_id: string;
  instrument: string;
  size: string;
  price?: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  time_in_force?: 'gtc' | 'ioc' | 'fok';
  post_only?: boolean;
  // SAFEGUARD anti naked-short: cuando true, GRVT solo deja que la orden
  // reduzca/cierre la posición existente; nunca abre ni aumenta. Lo usamos
  // en los SELL de toma de ganancia del grid LONG para que un sell jamás
  // pueda abrir un short por construcción.
  reduce_only?: boolean;
  metadata?: string;
}

export interface KlineCandle {
  openTime: number;   // unix milliseconds
  closeTime: number;  // unix milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;     // base volume
  trades: number;
}

export interface FundingPayment {
  sub_account_id: string;
  instrument: string;
  funding_rate: string;
  payment: string;
  position_size: string;
  funding_time: number;
}

export interface Ticker {
  instrument: string;
  last_price: string;
  best_bid: string;
  best_ask: string;
  open_price: string;
  high_price: string;
  low_price: string;
  volume_24h: string;
  buy_volume_24h_q: string;
  sell_volume_24h_q: string;
  funding_rate: string;
  next_funding_time: number;
  mark_price: string;
}

// Rate limiting: max 10 requests/segundo según specs
class RateLimiter {
  private requests: number[] = [];
  private maxRequests = 10;
  private timeWindow = 1000; // 1 segundo

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();

    // Remover requests viejos (fuera de ventana)
    this.requests = this.requests.filter(time => now - time < this.timeWindow);

    // Si estamos en el límite, esperar
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      if (oldestRequest) {
        const waitTime = this.timeWindow - (now - oldestRequest) + 50; // +50ms safety

        if (waitTime > 0) {
          console.log(`⏳ Rate limit: esperando ${waitTime}ms`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // Registrar nueva request
    this.requests.push(now);
  }
}

// ─── Per-user rate buckets ──────────────────────────────────────────
// GRVT enforces rate limits PER ACCOUNT, but the old implementation was a
// single module-level RateLimiter shared by every GRVTClient instance. In
// multi-tenant mode that made user B's bots queue behind user A's burst
// even though they hit different account quotas. Buckets are keyed by the
// GRVT account id (falling back to the API key), so:
//   - different users never contend on the same bucket
//   - multiple clients/bots of the SAME account share one bucket
//     (the account quota is shared no matter how many clients we create)
// The legacy env-based singleton uses a fixed 'legacy-env' bucket.
const rateBuckets = new Map<string, RateLimiter>();

function getRateBucket(key: string): RateLimiter {
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = new RateLimiter();
    rateBuckets.set(key, bucket);
  }
  return bucket;
}

/** Test-only: drop all rate buckets so each test starts clean. */
export function __resetRateBucketsForTests(): void {
  rateBuckets.clear();
}

// ─── Request coalescing for public/idempotent reads ─────────────────
// Multiple bots frequently ask for the same ticker within the same second.
// Coalescing shares ONE in-flight promise + a short-TTL cached result per
// key instead of issuing N identical API calls. Applied ONLY to public,
// safe-to-share data (ticker, instrument metadata) — never to user-specific
// endpoints (orders, balance, fills).
//
// Note: server/cache.ts has a TtlCache, but (a) it lives in the server layer
// and importing it here would pull pino into every client consumer, and
// (b) it explicitly does NOT dedupe in-flight fetchers (racing callers both
// call the fetcher — see its getOrFetch doc). The in-flight map is the whole
// point here, so we keep a minimal local implementation.
const TICKER_COALESCE_TTL_MS = 1000;
const INSTRUMENTS_COALESCE_TTL_MS = 10_000;

interface CoalesceEntry {
  value: unknown;
  expiresAt: number;
}

const coalesceCache = new Map<string, CoalesceEntry>();
const coalesceInflight = new Map<string, Promise<unknown>>();

async function coalesce<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = coalesceCache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  const pending = coalesceInflight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }
  const p = (async () => {
    try {
      const value = await fetcher();
      // Only successes are cached — a rejection propagates to all current
      // waiters and the next caller retries fresh.
      coalesceCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      coalesceInflight.delete(key);
    }
  })();
  coalesceInflight.set(key, p);
  return p;
}

/** Test-only: drop coalescing state so each test starts clean. */
export function __resetCoalesceForTests(): void {
  coalesceCache.clear();
  coalesceInflight.clear();
}

// ─── 429 backoff with jitter ────────────────────────────────────────
// When GRVT answers 429 on a READ, retry with exponential backoff + equal
// jitter. Mutations (createOrder/cancelOrder/setLeverage) are intentionally
// NOT retried here: grid-engine has its own 429 handling for createOrder,
// and blindly retrying mutations risks duplicates.
const MAX_429_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

function is429RateLimit(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!error.message.includes('HTTP 429')) return false;
  // GRVT also uses HTTP 429 for the app-level "Max open orders exceeded"
  // (code 2090) — backing off won't fix that, let the caller handle it.
  if (error.message.includes('2090')) return false;
  return true;
}

function backoffDelayMs(attempt: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  // Equal jitter: half fixed + half random, so retries de-synchronize
  // across bots instead of stampeding GRVT again in lockstep.
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

async function withRateLimitBackoff<T>(
  ctx: { user: string; endpoint: string },
  fn: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!is429RateLimit(error) || attempt >= MAX_429_RETRIES) {
        throw error;
      }
      const delay = backoffDelayMs(attempt);
      console.warn(
        `⚠️ GRVT 429 rate-limited (user=${ctx.user}, endpoint=${ctx.endpoint}) — retry ${attempt + 1}/${MAX_429_RETRIES} in ${delay}ms`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// H.1: dynamic instrument specs cache. Populated by getInstruments(),
// with hardcoded fallbacks for the most common pairs so the bot works even
// if the API call fails or hasn't been made yet.
export interface InstrumentSpec {
  min_size: number;
  min_notional: number;
  tick_size: number;
  // H.8 Multi-pair: required for EIP-712 signing. Falls back to safe
  // defaults if unknown (base_decimals=9 is correct for most).
  instrument_hash?: string;
  base_decimals?: number;
}

const instrumentSpecsCache = new Map<string, InstrumentSpec>([
  ['BTC_USDT_Perp', { min_size: 0.001, min_notional: 100, tick_size: 0.1, instrument_hash: '0x030501', base_decimals: 9 }],
  ['ETH_USDT_Perp', { min_size: 0.001, min_notional: 20, tick_size: 0.01, instrument_hash: '0x030401', base_decimals: 9 }],
  ['SOL_USDT_Perp', { min_size: 0.01, min_notional: 5, tick_size: 0.01, base_decimals: 9 }],
]);

/** Get instrument specs — falls back to conservative defaults for unknown pairs. */
export function getInstrumentSpec(pair: string): InstrumentSpec {
  return instrumentSpecsCache.get(pair) ?? { min_size: 0.01, min_notional: 5, tick_size: 0.01, base_decimals: 9 };
}

/**
 * Explicit GRVT credentials passed to the constructor for multi-tenant
 * mode. When omitted, the client falls back to env vars (legacy path).
 */
export interface GrvtClientCreds {
  apiKey: string;
  apiSecret: string;        // private key for EIP-712 signing
  tradingAddress: string;    // wallet address matching the private key
  accountId: string;         // GRVT account id
  subAccountId: string;      // GRVT sub-account id
}

/**
 * GRVT API Client Class.
 *
 * Multi-tenant: if `creds` are passed to the constructor, the client
 * uses those explicitly (per-user mode). If omitted, falls back to
 * env vars (legacy singleton mode). Each instance has its own auth
 * state so cookie sessions don't leak between users.
 */
export class GRVTClient {
  private tradingAccountId: string;
  // Per-instance credentials. null → use env (legacy path).
  private creds: GrvtClientCreds | null;
  // Per-instance auth state so each user's cookie session is isolated.
  private instanceAuthState: import('./auth.js').AuthState;
  // Rate bucket key: GRVT account id (rate limits are per account), so all
  // clients of the same user share one bucket and different users never
  // contend. Falls back to apiKey if accountId is empty; legacy env path
  // uses a fixed key.
  private rateBucketKey: string;

  constructor(creds?: GrvtClientCreds) {
    this.instanceAuthState = createEmptyAuthState();
    this.creds = creds ?? null;
    this.rateBucketKey = creds ? (creds.accountId || creds.apiKey) : 'legacy-env';

    if (creds) {
      this.tradingAccountId = creds.subAccountId;
    } else {
      // Legacy fallback: read from env. In multi-tenant deploys none of
      // the GRVT_* env vars are set (each user supplies their own creds
      // via the dashboard). The legacy singleton may still be imported
      // but its tradingAccountId is never used for order placement —
      // defer the validation to actual use, only throw at construction
      // when the operator clearly intended legacy mode (some env var is
      // set but the account id is missing).
      const isMockMode = process.env.MOCK_MODE === 'true' || process.env.DRY_RUN === 'true';
      const legacyEnvIntent = !!(process.env.GRVT_API_KEY || process.env.GRVT_API_SECRET || process.env.GRVT_TRADING_ADDRESS);
      this.tradingAccountId = process.env.GRVT_TRADING_ACCOUNT_ID || (isMockMode ? 'mock-account' : '');
      if (!this.tradingAccountId && legacyEnvIntent) {
        throw new Error('GRVT_TRADING_ACCOUNT_ID required when using legacy env-based auth (other GRVT_* env vars are set). Set MOCK_MODE=true to bypass.');
      }
    }
  }

  /** Public accessor for the sub-account id this client authenticates
   *  as. Callers that build createOrder() payloads need it to populate
   *  the sub_account_id field correctly for multi-tenant bots. */
  get subAccountId(): string {
    return this.tradingAccountId;
  }

  /** Login to GRVT using this client's API key. Only needed when
   *  using explicit creds — the legacy path re-auths inside
   *  authenticatedRequest(). */
  async login(): Promise<boolean> {
    if (this.creds) {
      return authenticateWithKey(this.creds.apiKey, this.instanceAuthState);
    }
    return authenticateGRVT();
  }

  /** Make an authenticated request using per-instance or global auth. */
  private async authedRequest(url: string, body: object = {}, options?: { method?: string; timeout?: number }): Promise<any> {
    if (this.creds) {
      return authenticatedRequestWithState(this.instanceAuthState, this.creds.apiKey, url, body, options);
    }
    return authenticatedRequest(url, body, options);
  }

  /** Wait on this client's per-account rate bucket. */
  private rateLimit(): Promise<void> {
    return getRateBucket(this.rateBucketKey).waitIfNeeded();
  }

  /** Identity string for 429 warning logs. */
  private get userLabel(): string {
    return this.creds ? `account=${this.creds.accountId} sub=${this.creds.subAccountId}` : 'legacy-env';
  }

  /**
   * Run an idempotent READ with 429 backoff. Each retry attempt re-acquires
   * a rate-bucket slot so retries also count against the account quota.
   */
  private readWithBackoff<T>(endpoint: string, fn: () => Promise<T>, rateLimited = true): Promise<T> {
    return withRateLimitBackoff({ user: this.userLabel, endpoint }, async () => {
      if (rateLimited) await this.rateLimit();
      return fn();
    });
  }

  /** Get the signing credentials for this client (for order-signer). */
  getSigningCreds(): { privateKey: string; signerAddress: string; subAccountId: string } {
    if (this.creds) {
      return {
        privateKey: this.creds.apiSecret,
        signerAddress: this.creds.tradingAddress,
        subAccountId: this.creds.subAccountId,
      };
    }
    // Legacy: from env
    const privateKey = process.env.GRVT_API_SECRET;
    const signerAddress = process.env.GRVT_TRADING_ADDRESS;
    const subAccountId = process.env.GRVT_TRADING_ACCOUNT_ID;
    if (!privateKey || !signerAddress || !subAccountId) {
      throw new Error('Credenciales faltantes: GRVT_API_SECRET, GRVT_TRADING_ADDRESS, GRVT_TRADING_ACCOUNT_ID');
    }
    return { privateKey, signerAddress, subAccountId };
  }

  // === MARKET DATA (público) ===

  /**
   * Obtener ticker para un instrumento
   */
  async getTicker(instrument: string): Promise<Ticker> {
    // Coalesced: N concurrent callers for the same instrument share one
    // in-flight request + a ~1s cached result. Public data, safe to share
    // across users.
    return coalesce(`ticker:${instrument}`, TICKER_COALESCE_TTL_MS, () =>
      this.readWithBackoff('ticker', () =>
        publicRequest(`${MARKET_DATA_URL}/ticker`, { instrument }), false)
    );
  }

  /**
   * Obtener múltiples tickers
   */
  async getTickers(instruments: string[]): Promise<Ticker[]> {
    const promises = instruments.map(instrument => this.getTicker(instrument));
    return Promise.all(promises);
  }

  /**
   * Obtener instrumentos disponibles
   */
  async getInstruments(): Promise<any[]> {
    // Coalesced: instrument metadata is identical for every user and changes
    // rarely, so concurrent/bursty callers share one request for 10s.
    const data = await coalesce('instruments', INSTRUMENTS_COALESCE_TTL_MS, () =>
      this.readWithBackoff('instruments', () =>
        publicRequest(`${MARKET_DATA_URL}/instruments`, {}), false)
    );
    // H.1: cache instrument specs for dynamic pair support.
    // H.8: also cache instrument_hash + base_decimals for EIP-712 signing.
    if (Array.isArray(data)) {
      for (const inst of data) {
        const name = inst.instrument ?? inst.symbol ?? inst.name;
        if (name && typeof name === 'string') {
          const minSize = parseFloat(inst.base_min_size ?? inst.min_size ?? '0.01');
          const minNotional = parseFloat(inst.quote_min_size ?? inst.min_notional ?? '20');
          const tickSize = parseFloat(inst.tick_size ?? '0.01');
          const instrumentHash = inst.instrument_hash;
          const baseDecimals = inst.base_decimals != null
            ? parseInt(String(inst.base_decimals), 10)
            : 9;
          if (minSize > 0) {
            instrumentSpecsCache.set(name, {
              min_size: minSize,
              min_notional: minNotional,
              tick_size: tickSize,
              instrument_hash: instrumentHash,
              base_decimals: baseDecimals,
            });
          }
        }
      }
    }
    return data;
  }

  /**
   * Get historical kline (candlestick) data for an instrument.
   *
   * GRVT's kline endpoint quirks:
   *   - Required field `type` must be "TRADE" (no other modes used in production).
   *   - `interval` uses GRVT's CI_<n>_<unit> enum (e.g. "CI_1_M", "CI_1_H",
   *     "CI_4_H", "CI_1_D"). NOT "1h" / "1m".
   *   - `open_time` / `close_time` come back as **nanosecond strings**
   *     (not millis, not numbers). The dashboard divides by 1e6 to render.
   *   - `start_time` / `end_time` go in as nanoseconds too if provided.
   *   - The API returns rows in **reverse chronological order** (newest first).
   *     The chart wants ascending, so the v2-router reverses before sending.
   */
  async getKlines(
    instrument: string,
    interval: string = 'CI_1_H',
    limit: number = 500
  ): Promise<KlineCandle[]> {
    const data = await this.readWithBackoff('kline', () =>
      publicRequest(`${MARKET_DATA_URL}/kline`, {
        instrument,
        interval,
        type: 'TRADE',
        limit
      }), false);
    // publicRequest already unwraps `.result` from the GRVT envelope, so
    // `data` is normally the rows array. But if GRVT ever returns the
    // wrapped object directly we still want to handle it — accept both.
    const rows: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.result)
        ? data.result
        : [];
    return rows.map((row): KlineCandle => ({
      openTime: Number(row.open_time) / 1_000_000, // ns string -> ms
      closeTime: Number(row.close_time) / 1_000_000,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume_b ?? '0'),
      trades: Number(row.trades ?? 0)
    }));
  }

  // === TRADING API (autenticado) ===

  /**
   * Obtener balance de la cuenta trading
   */
  async getBalance(): Promise<Balance> {
    const data = await this.readWithBackoff('account_summary', () =>
      this.authedRequest(`${TRADING_URL}/account_summary`, {
        sub_account_id: this.tradingAccountId
      }));

    return {
      sub_account_id: this.tradingAccountId,
      total_equity: data.total_equity || '0',
      available_balance: data.available_balance || '0',
      margin_used: data.margin_used || '0',
      maintenance_margin: data.maintenance_margin || '0',
      initial_margin: data.initial_margin || '0',
      currency: 'USDT'
    };
  }

  /**
   * Obtener todas las posiciones
   */
  async getPositions(): Promise<Position[]> {
    const data = await this.readWithBackoff('positions', () =>
      this.authedRequest(`${TRADING_URL}/positions`, { sub_account_id: this.tradingAccountId }));
    return Array.isArray(data) ? data : [];
  }

  /**
   * Obtener posición específica
   */
  async getPosition(instrument: string): Promise<Position | null> {
    const positions = await this.getPositions();
    return positions.find(p => p.instrument === instrument) || null;
  }

  /**
   * Obtener órdenes abiertas
   */
  async getOpenOrders(instrument?: string): Promise<Order[]> {
    const body: any = { sub_account_id: this.tradingAccountId };
    if (instrument) {
      body.instrument = instrument;
    }

    const data = await this.readWithBackoff('open_orders', () =>
      this.authedRequest(`${TRADING_URL}/open_orders`, body));
    const all = Array.isArray(data) ? data : [];

    // DEFENSIVE: GRVT's open_orders endpoint sometimes ignores the `instrument`
    // filter and returns ALL orders in the sub-account. Seen on 2026-04-16 when
    // creating a SOL bot while ETH bot 44 had 93 open orders — GRVT returned
    // all 93 ETH orders to the SOL query, which made the engine think SOL had
    // 93 orphan orders. Filter client-side to guarantee correctness.
    if (!instrument) return all;
    return all.filter((o: any) => {
      // instrument can be at the order level or inside legs[0]
      if (o.instrument === instrument) return true;
      const leg = o.legs?.[0];
      if (leg?.instrument === instrument) return true;
      return false;
    });
  }

  /**
   * Crear orden con firma EIP-712 (LIMIT para grid, MARKET para compra inicial/cierre)
   * ⚠️ ACTUALIZADO: endpoint /full/v1/create_order con formato verificado
   */
  async createOrder(request: CreateOrderRequest, allowMarket: boolean = false): Promise<Order> {
    await this.rateLimit();

    // SAFEGUARD: Solo órdenes LIMIT excepto casos especiales (compra inicial/cierre)
    if (request.type !== 'limit' && !allowMarket) {
      throw new Error('SAFEGUARD: Solo se permiten órdenes LIMIT (usar allowMarket=true para casos especiales)');
    }

    // Market orders (escalación de cierre SL/TP): el signer ya soportaba
    // isMarket/timeInForce pero este método nunca los pasaba — toda orden
    // se firmaba como LIMIT GTC aunque request.type fuese 'market'. Ahora
    // is_market=true se firma con limitPrice=0 (parte del typed-data EIP-712)
    // y el payload omite limit_price. request.price queda como precio de
    // REFERENCIA para la validación de min_notional (no se envía a GRVT).
    const isMarket = request.type === 'market';
    // Mapeo time_in_force → uint8 de la firma EIP-712: GTC=1, IOC=3.
    // Las market van IOC (GRVT no acepta market resting); default legacy GTC.
    const timeInForce = request.time_in_force === 'ioc' ? 3 : 1;

    // SAFEGUARD: Validar min_size y min_notional (tick_size solo para limit:
    // el precio de una market es referencia, no viaja en la orden).
    this.validateOrderSize(request.instrument, request.size, request.price, isMarket);

    console.log(`📝 Creando orden: ${request.side} ${request.size} ${request.instrument} @ ${isMarket ? 'MARKET' : request.price}`);

    try {
      // Firmar orden con EIP-712 — pass per-instance signing creds
      // so multi-tenant clients each sign with their own private key.
      const sc = this.getSigningCreds();
      const signedOrder = await signOrder({
        instrument: request.instrument,
        side: request.side,
        size: request.size,
        price: request.price,
        isMarket,
        timeInForce,
        postOnly: request.post_only || false,
        reduceOnly: request.reduce_only || false,
      }, {
        privateKey: sc.privateKey,
        signerAddress: sc.signerAddress,
        subAccountId: sc.subAccountId,
      });

      // Formatear para API de GRVT
      const orderData = formatSignedOrderForAPI(
        signedOrder,
        request.instrument,
        request.size,
        request.price,
        request.side
      );

      console.log('🔏 Orden firmada, enviando a GRVT...');
      
      // ⚠️ CAMBIO: endpoint /full/v1/create_order
      const data = await this.authedRequest(`${TRADING_URL}/create_order`, orderData);
      
      console.log('✅ Respuesta GRVT createOrder:', data);
      
      // ⚠️ CAMBIO: respuesta contiene order_id en result
      // Extraer client_order_id del request enviado para tracking
      const clientOrderId = orderData?.order?.metadata?.client_order_id || String(Date.now());
      return {
        order_id: data.result?.order_id || data.order_id,
        sub_account_id: request.sub_account_id,
        instrument: request.instrument,
        size: request.size,
        filled_size: '0',
        price: request.price || '0',
        side: request.side,
        type: request.type,
        status: 'open',
        time_in_force: request.time_in_force || 'gtc',
        created_time: Date.now(),
        updated_time: Date.now(),
        metadata: clientOrderId
      } as Order;

    } catch (error) {
      // El error de authedRequest es `HTTP <status>: <errorText>` con el BODY
      // CRUDO de GRVT. El engine matchea ese texto para detectar rechazos de
      // margen insuficiente (INSUFFICIENT_MARGIN_RE en grid-engine) y frenar el
      // grid, así que NO lo envolvemos ni lo aplanamos: re-lanzamos tal cual
      // para preservar la signature de GRVT. Logueamos el body completo para
      // poder confirmar la signature real de "cross margin insufficient".
      console.error('❌ Error creando orden firmada (GRVT body crudo):', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  /**
   * Cancelar orden específica
   */
  async cancelOrder(orderId: string, instrument: string): Promise<boolean> {
    await this.rateLimit();

    console.log(`❌ Cancelando orden: ${orderId}`);
    
    try {
      await this.authedRequest(`${TRADING_URL}/cancel_order`, {
        sub_account_id: this.tradingAccountId,
        order_id: orderId,
        instrument: instrument
      });
      return true;
    } catch (error) {
      console.error(`Error cancelando orden ${orderId}:`, error);
      return false;
    }
  }

  /**
   * Cancelar todas las órdenes (por instrumento o todas)
   */
  async cancelAllOrders(instrument?: string): Promise<number> {
    await this.rateLimit();

    console.log(instrument ? 
      `❌ Cancelando todas las órdenes de ${instrument}` :
      '❌ Cancelando TODAS las órdenes'
    );

    const body: any = { sub_account_id: this.tradingAccountId };
    if (instrument) {
      body.instrument = instrument;
    }

    try {
      const data = await this.authedRequest(`${TRADING_URL}/cancel_all_orders`, body);
      const cancelledCount = data.cancelled_count || 0;
      console.log(`✅ ${cancelledCount} órdenes canceladas`);
      return cancelledCount;
    } catch (error) {
      console.error('Error cancelando órdenes:', error);
      return 0;
    }
  }

  /**
   * Establecer leverage para un instrumento
   */
  async setLeverage(instrument: string, leverage: number): Promise<boolean> {
    await this.rateLimit();

    console.log(`⚡ Estableciendo leverage ${leverage}x para ${instrument}`);

    try {
      await this.authedRequest(`${TRADING_URL}/set_leverage`, {
        sub_account_id: this.tradingAccountId,
        instrument: instrument,
        leverage: leverage.toString()
      });
      return true;
    } catch (error) {
      // ⚠️ DINERO REAL: GRVT puede rechazar el set_leverage (p.ej. posición
      // abierta, margin insuficiente, tier inválido). El caller usa el bool
      // para fallar-cerrado, pero SIN el cuerpo del error el operador no sabe
      // POR QUÉ rechazó. Logueamos el error completo (no sólo .message) para
      // diagnóstico. El tipo de retorno se mantiene boolean por compat.
      console.error(
        `Error estableciendo leverage ${leverage}x para ${instrument}:`,
        error instanceof Error ? error.message : error,
        error
      );
      return false;
    }
  }

  /**
   * Leer el leverage REALMENTE aplicado por GRVT para un instrumento desde
   * account_summary.positions[]. GRVT sólo expone el leverage por
   * instrumento cuando hay una posición abierta; si no hay posición devuelve
   * null (no es un error, simplemente no hay nada que leer todavía).
   *
   * Se usa para read-back tras setLeverage: el leverage es "sticky" en GRVT,
   * así que tras un set_leverage rechazado el bot operaría al leverage previo
   * mientras la DB muestra el nuevo. Esta lectura permite fallar-cerrado.
   */
  async getAppliedLeverage(instrument: string): Promise<number | null> {
    const data = await this.readWithBackoff('account_summary', () =>
      this.authedRequest(`${TRADING_URL}/account_summary`, {
        sub_account_id: this.tradingAccountId
      }));

    if (data.positions && Array.isArray(data.positions)) {
      const pos = data.positions.find((p: any) => p.instrument === instrument);
      if (pos && pos.leverage != null) {
        const lev = parseFloat(pos.leverage);
        return Number.isFinite(lev) ? lev : null;
      }
    }
    // No hay posición para este instrumento → GRVT no expone el leverage
    // aplicado pre-posición. El caller decide qué hacer (verificar tras el
    // primer fill / en resume).
    return null;
  }

  /**
   * Obtener historial de fills (últimas N transacciones).
   *
   * `endTimeNs` is optional and lets a caller page backwards: pass the
   * oldest event_time of a previous batch to get fills strictly older
   * than that. GRVT returns fills ordered newest→oldest, so the typical
   * backfill loop is:
   *
   *   const all = [];
   *   let endTime: string | undefined = undefined;
   *   while (true) {
   *     const batch = await getFillHistory(1000, instrument, endTime);
   *     if (batch.length === 0) break;
   *     all.push(...batch);
   *     const oldest = batch[batch.length - 1];
   *     // Subtract 1 ns so the next batch is strictly before this one,
   *     // avoiding an infinite loop on the boundary fill.
   *     endTime = (BigInt(oldest.event_time) - 1n).toString();
   *     if (batch.length < 1000) break;  // last page
   *   }
   *
   * If GRVT silently ignores `end_time`, the loop will see the same
   * batch again and INSERT OR IGNORE in fills_archive will be a no-op,
   * but the loop will spin — the caller is responsible for an
   * iteration cap.
   */
  async getFillHistory(
    limit: number = 100,
    instrument?: string,
    endTimeNs?: string
  ): Promise<Fill[]> {
    const body: any = {
      sub_account_id: this.tradingAccountId,
      limit: Math.min(limit, 1000)
    };

    if (instrument) {
      body.instrument = instrument;
    }
    if (endTimeNs) {
      body.end_time = endTimeNs;
    }

    const data = await this.readWithBackoff('fill_history', () =>
      this.authedRequest(`${TRADING_URL}/fill_history`, body));
    return Array.isArray(data) ? data : [];
  }

  /**
   * Obtener historial de funding payments
   * ⚠️ FIX: GRVT usa POST para funding_history según specs
   */
  async getFundingHistory(limit: number = 100, instrument?: string): Promise<FundingPayment[]> {
    const body: any = {
      sub_account_id: this.tradingAccountId,
      limit: Math.min(limit, 1000)
    };
    
    if (instrument) {
      body.instrument = instrument;
    }

    try {
      // ⚠️ FIX: funding_history endpoint da 404, usar account_summary en su lugar
      console.log(`📡 [DEBUG] Getting funding from account_summary (funding_history no disponible)...`);
      
      // Obtener account_summary que incluye cumulative_realized_funding_payment
      const data = await this.readWithBackoff('account_summary', () =>
        this.authedRequest(`${TRADING_URL}/account_summary`, {
          sub_account_id: this.tradingAccountId
        }));
      
      const fundingPayments: FundingPayment[] = [];

      // Extraer funding de cada posición
      if (data.positions && Array.isArray(data.positions)) {
        for (const position of data.positions) {
          if (position.cumulative_realized_funding_payment !== undefined) {
            // ⚠️ DINERO REAL: cumulative_realized_funding_payment es un TOTAL
            // ACUMULADO por posición (ya en USDT, NO en raw/1e6), con SIGNO:
            // negativo = funding PAGADO (costo), positivo = funding RECIBIDO.
            // NO usar Math.abs — eso convertía funding recibido en costo y
            // multiplicaba la pérdida. El caller (pollFundingHistory) lo trata
            // como snapshot acumulado, NO como un evento per-poll.
            const fundingAmount = parseFloat(position.cumulative_realized_funding_payment || '0');

            // Filtrar por instrumento si se especifica
            if (!instrument || position.instrument === instrument) {
              fundingPayments.push({
                sub_account_id: this.tradingAccountId,
                instrument: position.instrument,
                funding_rate: '0', // No disponible en summary
                // BUG FIX: grid-engine.ts treats funding_time as SECONDS and
                // does `payment.funding_time * 1000` to convert to ms before
                // building a Date. Date.now() returns ms, so the *1000 was
                // turning ms into μs → year 058236 in the stored ISO string.
                // 739 rows in production were corrupted by this; backfilled
                // via SQL on deploy. New rows now correctly stamp seconds.
                funding_time: Math.floor(Date.now() / 1000),
                // SIGNO PRESERVADO (ver nota arriba): este es el cumulative
                // acumulado con signo, no un valor absoluto per-evento.
                payment: fundingAmount.toString(),
                position_size: position.size || '0'
              });

              console.log(`📡 [DEBUG] Funding acumulado for ${position.instrument}: ${fundingAmount} USDT (con signo)`);
            }
          }
        }
      }
      
      console.log(`📡 [DEBUG] Total funding payments found: ${fundingPayments.length}`);
      return fundingPayments;
      
    } catch (error) {
      console.error('Error obteniendo funding desde account_summary:', error);
      return [];
    }
  }

  // === VALIDACIONES Y SAFEGUARDS ===

  /**
   * Validar tamaño de orden según specs de instrumento.
   *
   * Para market orders (isMarket=true) el precio es de REFERENCIA (se usa
   * para el chequeo de min_notional pero no viaja a GRVT), así que el
   * chequeo de tick_size no aplica. Limit orders mantienen la validación
   * completa y siguen requiriendo precio.
   */
  private validateOrderSize(instrument: string, size: string, price: string | undefined, isMarket: boolean = false): void {
    const sizeNum = parseFloat(size);

    // H.1: dynamic specs from cache (populated by getInstruments, fallback hardcoded)
    const specs = getInstrumentSpec(instrument);

    if (sizeNum < specs.min_size) {
      throw new Error(`Tamaño ${size} menor que min_size ${specs.min_size} para ${instrument}`);
    }

    if (price == null || price === '') {
      if (!isMarket) {
        throw new Error(`Precio requerido para órdenes limit en ${instrument}`);
      }
      // Market sin precio de referencia: no podemos validar notional acá;
      // GRVT lo rechazará si viola min_notional (la escalación de cierre
      // siempre pasa el ticker como referencia, así que no llega acá).
      return;
    }

    const priceNum = parseFloat(price);
    const notional = sizeNum * priceNum;

    if (notional < specs.min_notional) {
      throw new Error(`Notional $${notional.toFixed(2)} menor que min_notional $${specs.min_notional} para ${instrument}`);
    }

    // Validar tick size usando aritmética más precisa (solo limit: el precio
    // de una market es referencia y no se envía).
    if (!isMarket) {
      const rounded = Math.round(priceNum / specs.tick_size) * specs.tick_size;
      const diff = Math.abs(priceNum - rounded);
      const tolerance = specs.tick_size / 1000;
      if (diff >= tolerance) {
        throw new Error(`Precio ${price} no es múltiplo de tick_size ${specs.tick_size} para ${instrument} (diff: ${diff})`);
      }
    }
  }

  /**
   * Calcular precio de liquidación aproximado
   */
  async calculateLiquidationPrice(instrument: string, leverage: number): Promise<string> {
    try {
      const position = await this.getPosition(instrument);
      if (!position) return '0';

      const entryPrice = parseFloat(position.entry_price);
      const maintenanceMarginRate = 0.005; // 0.5% típico
      
      // Aproximación: liq_price = entry_price * (1 ± (1/leverage - maintenance_margin))
      const factor = 1 / leverage - maintenanceMarginRate;
      
      let liquidationPrice: number;
      if (position.side === 'buy') {
        liquidationPrice = entryPrice * (1 - factor);
      } else {
        liquidationPrice = entryPrice * (1 + factor);
      }

      return Math.max(0, liquidationPrice).toFixed(2);

    } catch (error) {
      console.error('Error calculando liquidation price:', error);
      return '0';
    }
  }
}

// Instancia singleton del client
export const grvtClient = new GRVTClient();

export default grvtClient;