// SPDX-License-Identifier: Apache-2.0
//
// A minimal `graphql-transport-ws` client (the protocol the Midnight indexer serves at /api/v4/graphql/ws) on Node's
// global WebSocket. One subscription per connection; messages are buffered and pulled through an async iterator, so
// a slow consumer never loses a message. The caller ends a subscription by breaking out of the loop (or aborting).

export class SubscriptionError extends Error {
  override name = 'SubscriptionError';
}

type Message = { type: string; id?: string; payload?: unknown };

export interface SubscribeOptions {
  signal?: AbortSignal;
  /** Fail if the server has not acknowledged the connection within this time. */
  connectTimeoutMs?: number;
  /** Fail if no message arrives for this long after the first one (0 = never). */
  idleTimeoutMs?: number;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
}

export async function* subscribe<T>(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  o: SubscribeOptions = {},
): AsyncGenerator<T> {
  const WS = o.WebSocketImpl ?? globalThis.WebSocket;
  if (WS === undefined) throw new SubscriptionError('no WebSocket implementation (Node >= 22 provides one)');
  const ws = new WS(url, 'graphql-transport-ws');
  const queue: T[] = [];
  let done = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const fail = (e: Error) => {
    if (!done && failure === undefined) failure = e;
    notify();
  };
  let acked = false;
  const connectTimer = setTimeout(() => {
    if (!acked) fail(new SubscriptionError(`no connection_ack from ${url} within ${o.connectTimeoutMs ?? 15_000} ms`));
  }, o.connectTimeoutMs ?? 15_000);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (!o.idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new SubscriptionError(`no message from ${url} for ${o.idleTimeoutMs} ms`)), o.idleTimeoutMs);
  };
  const onAbort = () => fail(new SubscriptionError('aborted'));
  o.signal?.addEventListener('abort', onAbort);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
  ws.onerror = (ev: Event) =>
    fail(new SubscriptionError(`WebSocket error on ${url}: ${(ev as { message?: string }).message ?? 'unknown'}`));
  ws.onclose = (ev: CloseEvent) => {
    if (!done) fail(new SubscriptionError(`WebSocket closed by ${url} (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`));
  };
  ws.onmessage = (ev: MessageEvent) => {
    let msg: Message;
    try {
      msg = JSON.parse(String(ev.data)) as Message;
    } catch {
      fail(new SubscriptionError('unparseable message from the indexer'));
      return;
    }
    switch (msg.type) {
      case 'connection_ack':
        acked = true;
        clearTimeout(connectTimer);
        armIdle();
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'next': {
        armIdle();
        const p = msg.payload as { data?: T; errors?: unknown };
        if (p.errors !== undefined) fail(new SubscriptionError(`GraphQL error: ${JSON.stringify(p.errors)}`));
        else queue.push(p.data as T);
        notify();
        break;
      }
      case 'error':
        fail(new SubscriptionError(`GraphQL subscription error: ${JSON.stringify(msg.payload)}`));
        break;
      case 'complete':
        done = true;
        notify();
        break;
      default:
        break;
    }
  };

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as T;
        continue;
      }
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    done = true;
    clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    o.signal?.removeEventListener('abort', onAbort);
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: '1', type: 'complete' }));
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
