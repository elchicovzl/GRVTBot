// D.9 — WebSocket server tests.
// Spins up a real GrvtWebSocketServer on a random localhost port and
// drives it with a real `ws` client. No mocks for the WS layer — we
// want the actual handshake, frame parsing, and bus integration paths.
//
// Heartbeat: the server's interval is 30s which would be too slow for
// CI. We don't test the timer firing per se; instead we test the
// subscription cleanup that happens when a client closes (the same
// teardown the heartbeat uses).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { GrvtWebSocketServer } from '../src/server/ws-server';
import { wsBus, type WsMessage } from '../src/server/ws-bus';

const API_KEY = 'test-api-key-32-chars-long-xxxx';

let httpServer: HttpServer;
let wss: GrvtWebSocketServer;
let port: number;

function urlFor(query = `?api_key=${API_KEY}`): string {
  return `ws://127.0.0.1:${port}/ws${query}`;
}

// Wrapper around a `ws` client that buffers messages from the moment
// of construction. The naive pattern (attach listener after `await
// open`) loses messages dispatched between the open event and the
// next listener attachment — particularly the server's hello frame,
// which is sent in the same tick as the upgrade. This buffer guarantees
// every frame is captured.
class TestClient {
  ws: WebSocket;
  private queue: WsMessage[] = [];
  private waiters: Array<(m: WsMessage) => void> = [];
  closed: { code: number; reason: string } | null = null;

  constructor(query?: string) {
    this.ws = new WebSocket(urlFor(query));
    this.ws.on('message', (raw: Buffer) => {
      const m = JSON.parse(raw.toString()) as WsMessage;
      const w = this.waiters.shift();
      if (w) w(m); else this.queue.push(m);
    });
    this.ws.once('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
      this.ws.once('close', (code) => {
        if (code !== 1000) reject(new Error(`closed before open: ${code}`));
      });
    });
  }

  next(timeoutMs = 1000): Promise<WsMessage> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('next() timeout')), timeoutMs);
      this.waiters.push((m) => { clearTimeout(timer); resolve(m); });
    });
  }

  send(msg: object): void { this.ws.send(JSON.stringify(msg)); }
  close(): void { this.ws.close(); }
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

beforeEach(async () => {
  wsBus.clear();
  httpServer = createServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  port = (httpServer.address() as AddressInfo).port;
  wss = new GrvtWebSocketServer(httpServer, API_KEY);
});

afterEach(async () => {
  await wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  wsBus.clear();
});

describe('GrvtWebSocketServer (D.9)', () => {
  it('rejects connection with invalid api_key (close code 4401)', async () => {
    const ws = new WebSocket(urlFor('?api_key=wrong'));
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4401);
  });

  it('rejects connection without api_key', async () => {
    const ws = new WebSocket(urlFor(''));
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4401);
  });

  it('accepts valid api_key and sends a hello frame with clientId', async () => {
    const c = new TestClient();
    await c.open();
    const hello = await c.next();
    expect(hello.type).toBe('hello');
    expect(hello.channel).toBe('system');
    const data = hello.data as { clientId: string; serverVersion: string; protocolVersion: number };
    expect(data.clientId).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(data.protocolVersion).toBe(1);
    expect(wss.clientCount()).toBe(1);
    c.close();
  });

  it('subscribe + publish round-trip: client receives bus events on subscribed channel', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello

    c.send({ type: 'subscribe', channels: ['bot:42'] });
    const ack = await c.next();
    expect(ack.type).toBe('subscribed');
    expect((ack.data as { channels: string[] }).channels).toEqual(['bot:42']);

    wsBus.publish('bot:42', 'fill', { price: 2100, size: 0.05 });
    const event = await c.next();
    expect(event.type).toBe('fill');
    expect(event.channel).toBe('bot:42');
    expect(event.data).toEqual({ price: 2100, size: 0.05 });
    c.close();
  });

  it('does NOT deliver events for channels the client did not subscribe to', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello
    c.send({ type: 'subscribe', channels: ['bot:42'] });
    await c.next(); // ack

    wsBus.publish('bot:99', 'fill', { price: 999 });
    // Verify nothing arrived in 100ms — c.next() should time out.
    await expect(c.next(100)).rejects.toThrow(/timeout/);
    c.close();
  });

  it('unsubscribe stops delivery from that channel', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello
    c.send({ type: 'subscribe', channels: ['prices'] });
    await c.next(); // ack

    wsBus.publish('prices', 'tick', { eth: 2100 });
    const first = await c.next();
    expect(first.data).toEqual({ eth: 2100 });

    c.send({ type: 'unsubscribe', channels: ['prices'] });
    await new Promise((r) => setTimeout(r, 30)); // let server process unsubscribe

    wsBus.publish('prices', 'tick', { eth: 2200 });
    await expect(c.next(100)).rejects.toThrow(/timeout/);
    c.close();
  });

  it('responds to app-level ping with pong', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello

    c.send({ type: 'ping' });
    const pong = await c.next();
    expect(pong.type).toBe('pong');
    expect(pong.channel).toBe('system');
    c.close();
  });

  it('closes connection with 4400 on malformed JSON', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello
    c.ws.send('not-json');
    const closed = await nextClose(c.ws);
    expect(closed.code).toBe(4400);
  });

  it('cleans up subscriptions on disconnect (no orphan subscribers in bus)', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello
    c.send({ type: 'subscribe', channels: ['bot:7', 'prices'] });
    await c.next(); // ack
    expect(wsBus.subscriberCount()).toBe(2);

    // Closing the client must trigger the server-side teardown that
    // removes both subscriptions from the bus. Otherwise dead browser
    // tabs accumulate forever.
    const closedP = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
    c.close();
    await closedP;
    await new Promise((r) => setTimeout(r, 30));

    expect(wsBus.subscriberCount()).toBe(0);
    expect(wss.clientCount()).toBe(0);
  });

  it('subscribing to the same channel twice is idempotent', async () => {
    const c = new TestClient();
    await c.open();
    await c.next(); // hello
    c.send({ type: 'subscribe', channels: ['bot:1'] });
    await c.next(); // ack
    c.send({ type: 'subscribe', channels: ['bot:1'] });
    await c.next(); // ack again
    // Only ONE subscription registered with the bus despite two
    // subscribe frames — guards against duplicate-broadcast bugs.
    expect(wsBus.subscriberCount()).toBe(1);
    c.close();
  });
});
