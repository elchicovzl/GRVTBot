// Singleton WebSocket connection manager.
//
// Mirrors the protocol of packages/bot/src/server/ws-server.ts:
//   - URL: ws[s]://host/ws?token=<jwt>     (multi-tenant — preferred)
//          ws[s]://host/ws?api_key=<key>   (legacy operator/admin)
//   - Server sends `hello` on connect, `pong` on app-level ping
//   - Client subscribes to channels via { type: 'subscribe', channels: [...] }
//   - All frames JSON: { type, channel, data, timestamp }
//
// Reconnection: exponential backoff, capped. The hook layer (use-ws-channel)
// re-issues subscribe frames after every reconnect so consumers don't have to
// know about disconnect events.
//
// Auth lifecycle: the URL is built fresh on every connect() so that the
// current JWT (from localStorage) is picked up. After login/logout the
// auth context calls authChanged() to drop the old socket and reconnect
// with the new credentials.

const TOKEN_KEY = 'grvt-grid-token';

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface WsMessage<T = unknown> {
  type: string;
  channel: string;
  data: T;
  timestamp: number;
}

type Listener = (msg: WsMessage) => void;
type StatusListener = (status: WsStatus) => void;

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

class WsClient {
  private ws: WebSocket | null = null;
  private status: WsStatus = 'closed';
  private channelListeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<StatusListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;
  private appPingTimer: number | null = null;

  /**
   * Build the WS URL fresh each call so we pick up the current JWT from
   * localStorage (after login/logout). Prefers token= (multi-tenant)
   * over api_key= (legacy operator/admin baked in at build time).
   */
  private buildUrl(): string {
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
    const apiKey = import.meta.env.VITE_DASHBOARD_API_KEY ?? '';
    const baseOverride = import.meta.env.VITE_API_BASE_URL ?? '';
    let wsBase: string;
    if (baseOverride) {
      wsBase = baseOverride.replace(/^http/, 'ws');
    } else if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      wsBase = `${proto}://${window.location.host}`;
    } else {
      wsBase = 'ws://localhost:3848';
    }
    if (token) {
      return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
    }
    return `${wsBase}/ws?api_key=${encodeURIComponent(apiKey)}`;
  }

  /**
   * Lazy connect. Safe to call multiple times — only connects once.
   */
  connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.intentionallyClosed = false;
    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.buildUrl());
    } catch (err) {
      console.error('[ws] failed to construct WebSocket', err);
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setStatus('open');
      // Re-subscribe to all known channels after reconnect.
      const channels = Array.from(this.channelListeners.keys());
      if (channels.length > 0) {
        this.send({ type: 'subscribe', channels });
      }
      // App-level ping every 25s to keep things lively (the server also
      // does protocol-level pings every 30s; this is belt-and-suspenders).
      this.startAppPing();
    });

    this.ws.addEventListener('message', (event) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(event.data as string) as WsMessage;
      } catch {
        console.warn('[ws] received non-JSON frame', event.data);
        return;
      }
      this.dispatch(msg);
    });

    this.ws.addEventListener('close', (event) => {
      this.stopAppPing();
      this.ws = null;
      if (this.intentionallyClosed) {
        this.setStatus('closed');
        return;
      }
      // 4401 = unauthorized, don't retry blindly. In multi-tenant this
      // means we either have no JWT (user not logged in yet) or the
      // server rejected it (expired, signed with the wrong secret, etc).
      // In single-tenant operator mode it means VITE_DASHBOARD_API_KEY
      // baked into the build doesn't match the server.
      if (event.code === 4401) {
        const hasJwt =
          typeof localStorage !== 'undefined' && !!localStorage.getItem(TOKEN_KEY);
        console.error(
          hasJwt
            ? '[ws] unauthorized — JWT rejected by server'
            : '[ws] unauthorized — log in first (no JWT in localStorage)'
        );
        this.setStatus('error');
        return;
      }
      this.setStatus('closed');
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (err) => {
      console.warn('[ws] error', err);
      // The close handler will fire right after — let it handle reconnect.
    });
  }

  /**
   * Subscribe a listener to a channel. Returns unsubscribe.
   * Auto-connects if not already connected.
   */
  subscribe(channel: string, listener: Listener): () => void {
    let listeners = this.channelListeners.get(channel);
    const isFirstSubscriber = !listeners;
    if (!listeners) {
      listeners = new Set();
      this.channelListeners.set(channel, listeners);
    }
    listeners.add(listener);

    // Lazy connect on first subscription
    this.connect();

    // If we're already open, send subscribe immediately.
    // (If not open yet, the open handler will send it on connect.)
    if (isFirstSubscriber && this.status === 'open') {
      this.send({ type: 'subscribe', channels: [channel] });
    }

    return () => {
      const set = this.channelListeners.get(channel);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.channelListeners.delete(channel);
        if (this.status === 'open') {
          this.send({ type: 'unsubscribe', channels: [channel] });
        }
      }
    };
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    // Fire immediately with current status so consumers don't have to
    // separately read it on mount.
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): WsStatus {
    return this.status;
  }

  /**
   * Call after login or logout. Drops the current socket (without
   * marking it as intentionally closed forever) and reconnects with
   * fresh credentials if anyone is still subscribed. If no subscribers,
   * lets lazy connect handle it next time a hook subscribes.
   */
  authChanged(): void {
    // Cancel any pending reconnect; we're about to trigger one explicitly.
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    if (this.ws) {
      // Close the current socket. We use a transient "intentionallyClosed"
      // window so the close handler doesn't immediately schedule a
      // reconnect with stale state — we'll trigger a fresh connect below.
      this.intentionallyClosed = true;
      try {
        this.ws.close(1000, 'auth change');
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.intentionallyClosed = false;
    }
    if (this.channelListeners.size > 0) {
      this.connect();
    } else {
      this.setStatus('closed');
    }
  }

  /**
   * Force-close. Used by tests / hot-reload.
   */
  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopAppPing();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
    }
  }

  private dispatch(msg: WsMessage): void {
    // System frames (hello, subscribed, pong) — log but no fanout.
    if (msg.channel === 'system') {
      if (msg.type === 'hello') {
        console.info('[ws] hello', msg.data);
      }
      return;
    }
    const listeners = this.channelListeners.get(msg.channel);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error('[ws] listener error', err);
      }
    }
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[ws] send failed', err);
    }
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('[ws] status listener error', err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectTimer != null) return;
    const delay =
      RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 30_000;
    this.reconnectAttempt += 1;
    console.info(`[ws] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startAppPing(): void {
    this.stopAppPing();
    this.appPingTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, 25_000);
  }

  private stopAppPing(): void {
    if (this.appPingTimer != null) {
      window.clearInterval(this.appPingTimer);
      this.appPingTimer = null;
    }
  }
}

// Module-level singleton — one WS connection per browser tab.
export const wsClient = new WsClient();
