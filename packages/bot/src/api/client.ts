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

const rateLimiter = new RateLimiter();

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

  constructor(creds?: GrvtClientCreds) {
    this.instanceAuthState = createEmptyAuthState();
    this.creds = creds ?? null;

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
    const data = await publicRequest(`${MARKET_DATA_URL}/ticker`, {
      instrument
    });
    return data;
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
    const data = await publicRequest(`${MARKET_DATA_URL}/instruments`, {});
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
    const data = await publicRequest(`${MARKET_DATA_URL}/kline`, {
      instrument,
      interval,
      type: 'TRADE',
      limit
    });
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
    await rateLimiter.waitIfNeeded();
    
    const data = await this.authedRequest(`${TRADING_URL}/account_summary`, {
      sub_account_id: this.tradingAccountId
    });
    
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
    await rateLimiter.waitIfNeeded();
    
    const data = await this.authedRequest(`${TRADING_URL}/positions`, { sub_account_id: this.tradingAccountId });
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
    await rateLimiter.waitIfNeeded();

    const body: any = { sub_account_id: this.tradingAccountId };
    if (instrument) {
      body.instrument = instrument;
    }

    const data = await this.authedRequest(`${TRADING_URL}/open_orders`, body);
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
    await rateLimiter.waitIfNeeded();
    
    // SAFEGUARD: Solo órdenes LIMIT excepto casos especiales (compra inicial/cierre)
    if (request.type !== 'limit' && !allowMarket) {
      throw new Error('SAFEGUARD: Solo se permiten órdenes LIMIT (usar allowMarket=true para casos especiales)');
    }

    // SAFEGUARD: Validar min_size y min_notional
    this.validateOrderSize(request.instrument, request.size, request.price!);

    console.log(`📝 Creando orden: ${request.side} ${request.size} ${request.instrument} @ ${request.price}`);
    
    try {
      // Firmar orden con EIP-712 — pass per-instance signing creds
      // so multi-tenant clients each sign with their own private key.
      const sc = this.getSigningCreds();
      const signedOrder = await signOrder({
        instrument: request.instrument,
        side: request.side,
        size: request.size,
        price: request.price!,
        postOnly: request.post_only || false,
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
        request.price!,
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
      console.error('❌ Error creando orden firmada:', error);
      throw error;
    }
  }

  /**
   * Cancelar orden específica
   */
  async cancelOrder(orderId: string, instrument: string): Promise<boolean> {
    await rateLimiter.waitIfNeeded();
    
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
    await rateLimiter.waitIfNeeded();
    
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
    await rateLimiter.waitIfNeeded();
    
    console.log(`⚡ Estableciendo leverage ${leverage}x para ${instrument}`);
    
    try {
      await this.authedRequest(`${TRADING_URL}/set_leverage`, {
        sub_account_id: this.tradingAccountId,
        instrument: instrument,
        leverage: leverage.toString()
      });
      return true;
    } catch (error) {
      console.error(`Error estableciendo leverage:`, error);
      return false;
    }
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
    await rateLimiter.waitIfNeeded();

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

    const data = await this.authedRequest(`${TRADING_URL}/fill_history`, body);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Obtener historial de funding payments
   * ⚠️ FIX: GRVT usa POST para funding_history según specs
   */
  async getFundingHistory(limit: number = 100, instrument?: string): Promise<FundingPayment[]> {
    await rateLimiter.waitIfNeeded();
    
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
      const data = await this.authedRequest(`${TRADING_URL}/account_summary`, {
        sub_account_id: this.tradingAccountId
      });
      
      const fundingPayments: FundingPayment[] = [];
      
      // Extraer funding de cada posición
      if (data.positions && Array.isArray(data.positions)) {
        for (const position of data.positions) {
          if (position.cumulative_realized_funding_payment !== undefined) {
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
                payment: Math.abs(fundingAmount).toString(), // Valor absoluto
                position_size: position.size || '0'
              });
              
              console.log(`📡 [DEBUG] Funding for ${position.instrument}: ${fundingAmount} USDT`);
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
   * Validar tamaño de orden según specs de instrumento
   */
  private validateOrderSize(instrument: string, size: string, price: string): void {
    const sizeNum = parseFloat(size);
    const priceNum = parseFloat(price);
    const notional = sizeNum * priceNum;

    // H.1: dynamic specs from cache (populated by getInstruments, fallback hardcoded)
    const specs = getInstrumentSpec(instrument);

    if (sizeNum < specs.min_size) {
      throw new Error(`Tamaño ${size} menor que min_size ${specs.min_size} para ${instrument}`);
    }

    if (notional < specs.min_notional) {
      throw new Error(`Notional $${notional.toFixed(2)} menor que min_notional $${specs.min_notional} para ${instrument}`);
    }

    // Validar tick size usando aritmética más precisa
    const rounded = Math.round(priceNum / specs.tick_size) * specs.tick_size;
    const diff = Math.abs(priceNum - rounded);
    const tolerance = specs.tick_size / 1000;
    if (diff >= tolerance) {
      throw new Error(`Precio ${price} no es múltiplo de tick_size ${specs.tick_size} para ${instrument} (diff: ${diff})`);
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