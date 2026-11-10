// SPDX-License-Identifier: Apache-2.0
//
// Errors built at the transport boundaries never carry the project token or a token-bearing URL, whatever the server
// echoes: GraphQL `errors` (HTTP and WebSocket), JSON-RPC `error`, the identity check's unexpected answer, a WebSocket
// close reason and error event, a fetch failure whose text holds the bare token. Every server here is a local stub on
// 127.0.0.1 that echoes the request URL (which carries `project_id`) and the token itself.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { HttpClient, HttpError } from '../src/http.ts';
import { IndexerError } from '../src/indexer.ts';
import { checkIdentity, IdentityError, indexerFor, resolveProfile, rpcFor, type NetworkProfile } from '../src/network.ts';
import { RpcError } from '../src/rpc.ts';
import { subscribe, SubscriptionError } from '../src/ws.ts';

const TOKEN = 'FakeTokenTransport0123456789';

/** Everything an error exposes: message, string form, stack, own enumerable fields and the whole cause chain. */
function exposed(e: unknown): string {
  const parts: string[] = [];
  let x: unknown = e;
  for (let i = 0; x !== undefined && x !== null && i < 10; i++) {
    const o = x as Error & Record<string, unknown>;
    parts.push(String(o), String(o.message), String(o.stack), JSON.stringify(o));
    x = o.cause;
  }
  return parts.join('\n');
}

async function failure(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => new Error('resolved'),
    (e: unknown) => e as Error,
  );
}

let server: Server;
let base: string;
let wss: WebSocketServer;
let profile: NetworkProfile;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const echoed = req.url ?? '';
      const ok = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      const b = JSON.parse(body || '{}') as { method?: string; query?: string };
      if (b.method === 'chain_getBlockHash') return ok({ jsonrpc: '2.0', id: 1, result: null, echo: `${echoed} token ${TOKEN}` });
      if (b.method !== undefined)
        return ok({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `denied for ${echoed}`, data: { project_id: TOKEN } } });
      return ok({
        errors: [
          { message: `unauthorised request http://127.0.0.1${echoed}`, extensions: { project_id: TOKEN, raw: `project_id%3D${TOKEN}` } },
          { message: `URLSearchParams { 'project_id' => '${TOKEN}' } and project_id: ${TOKEN}` },
        ],
      });
    });
  });
  wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'graphql-transport-ws' });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const echoed = req.url ?? '';
      const path = new URL(echoed, 'http://stub').pathname;
      if (path.endsWith('/close')) ws.close(4403, `forbidden ${echoed}`.slice(0, 120));
      else if (path.endsWith('/gql-error')) {
        ws.send(JSON.stringify({ type: 'connection_ack' }));
        ws.send(JSON.stringify({ type: 'error', id: '1', payload: [{ message: `denied ${echoed}`, project_id: TOKEN }] }));
      } else if (path.endsWith('/next-errors')) {
        ws.send(JSON.stringify({ type: 'connection_ack' }));
        ws.send(JSON.stringify({ type: 'next', id: '1', payload: { errors: [{ message: `bad token ${TOKEN}` }] } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A preprod profile pointed at the stub: every request carries the token as project_id, and the token is registered.
  profile = resolveProfile('preprod', { rpc: base, indexer: `${base}/api/v0` }, { MIP0018_BLOCKFROST_PREPROD: TOKEN });
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('transport errors are scrubbed where they are built', () => {
  it('IndexerError: GraphQL errors that echo the URL and the token (in every notation)', async () => {
    const e = await failure(indexerFor(profile, new HttpClient({ attempts: 1 })).latestBlock());
    expect(e).toBeInstanceOf(IndexerError);
    expect(e.message).toMatch(/indexer GraphQL error/u);
    expect(exposed(e)).not.toContain(TOKEN);
  });

  it('RpcError: a JSON-RPC error that echoes the URL and the token', async () => {
    const e = await failure(rpcFor(profile, new HttpClient({ attempts: 1 })).call('system_version'));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.message).toMatch(/RPC system_version failed/u);
    expect(exposed(e)).not.toContain(TOKEN);
  });

  it('IdentityError: an unexpected identity answer that echoes the URL and the token', async () => {
    const e = await failure(checkIdentity(profile, new HttpClient({ attempts: 1 })));
    expect(e).toBeInstanceOf(IdentityError);
    expect(e.message).toMatch(/did not return a genesis hash/u);
    expect(exposed(e)).not.toContain(TOKEN);
  });

  it('SubscriptionError: a close reason that echoes the URL', async () => {
    const url = `${base.replace('http', 'ws')}/close?project_id=${TOKEN}`;
    const e = await failure(subscribe(url, 'subscription { x }', {}, { connectTimeoutMs: 5_000 }).next());
    expect(e).toBeInstanceOf(SubscriptionError);
    expect(e.message).toMatch(/WebSocket closed by .* \(code 4403/u);
    expect(exposed(e)).not.toContain(TOKEN);
  });

  it('SubscriptionError: GraphQL subscription errors (error message, next with errors) that echo the URL and the token', async () => {
    for (const path of ['gql-error', 'next-errors']) {
      const e = await failure(
        subscribe(
          `${base.replace('http', 'ws')}/${path}?project_id=${TOKEN}`,
          'subscription { x }',
          {},
          { connectTimeoutMs: 5_000 },
        ).next(),
      );
      expect(e).toBeInstanceOf(SubscriptionError);
      expect(e.message).toMatch(/GraphQL/u);
      expect(exposed(e)).not.toContain(TOKEN);
    }
  });

  it('SubscriptionError: a WebSocket error event, and a WebSocket that cannot be opened, that quote the URL', async () => {
    class EchoingErrorSocket {
      readonly OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      onerror?: (ev: unknown) => void;
      onclose?: (ev: unknown) => void;
      onmessage?: (ev: unknown) => void;
      constructor(url: string) {
        setTimeout(() => this.onerror?.({ message: `connect failed: ${url} (token ${TOKEN})` }), 5);
      }
      send(): void {}
      close(): void {}
    }
    const viaEvent = await failure(
      subscribe(
        `wss://indexer.example/ws?project_id=${TOKEN}`,
        'subscription { x }',
        {},
        {
          WebSocketImpl: EchoingErrorSocket as unknown as typeof WebSocket,
          connectTimeoutMs: 5_000,
        },
      ).next(),
    );
    expect(viaEvent).toBeInstanceOf(SubscriptionError);
    expect(viaEvent.message).toMatch(/WebSocket error on wss:\/\/indexer\.example\/ws/u);
    expect(exposed(viaEvent)).not.toContain(TOKEN);

    class ThrowingSocket {
      constructor(url: string) {
        throw new SyntaxError(`Failed to construct 'WebSocket': the URL '${url}' is invalid (token ${TOKEN})`);
      }
    }
    const atOpen = await failure(
      subscribe(
        `wss://indexer.example/ws?project_id=${TOKEN}`,
        'subscription { x }',
        {},
        {
          WebSocketImpl: ThrowingSocket as unknown as typeof WebSocket,
        },
      ).next(),
    );
    expect(atOpen).toBeInstanceOf(SubscriptionError);
    expect(exposed(atOpen)).not.toContain(TOKEN);
  });

  it('HttpError: a fetch failure whose text and cause hold the bare token and the token-bearing URL', async () => {
    const http = new HttpClient({
      attempts: 1,
      fetch: (async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`, {
          cause: new Error(`upstream refused token ${TOKEN} at ${url}`),
        });
      }) as unknown as typeof fetch,
    });
    const post = await failure(http.postJson(`https://rpc.example/?project_id=${TOKEN}`, {}));
    expect(post).toBeInstanceOf(HttpError);
    expect(post.message).toMatch(/request to https:\/\/rpc\.example\/ failed/u);
    expect(exposed(post)).not.toContain(TOKEN);
    const get = await failure(http.getText(`https://prover.example/version?project_id=${TOKEN}`));
    expect(get).toBeInstanceOf(HttpError);
    expect(exposed(get)).not.toContain(TOKEN);
  });
});
