// SPDX-License-Identifier: Apache-2.0
//
// A Blockfrost-like front for the local stack, used by token-e2e.sh. Every HTTP request and every WebSocket upgrade
// must carry `project_id=<the value of $STUB_TOKEN>`; anything else is answered 403 with Blockfrost's error body.
// Accepted requests go to the local node and indexer:
//
//   /rpc         node JSON-RPC over HTTP (POST) and WebSocket          → --rpc-upstream (http://node:9944)
//   /api/v0      indexer GraphQL over HTTP (POST)                      → --indexer-upstream (http://indexer:8088/api/v4/graphql)
//   /api/v0/ws   indexer GraphQL over WebSocket (graphql-transport-ws) → the same, /ws
//
// Three listeners: --port (plain), --genesis-port (answers chain_getBlockHash(0) over HTTP with --genesis, so a pinned
// public profile can run its read-only commands against the local chain), --limit-port (answers the first
// --too-many requests with 429 and Retry-After: 1, then forwards).
//
// It writes one line per request to stdout WITHOUT the query string, and counts requests with and without the token;
// GET /stub-stats on any listener (with the token) returns the counts.
//
//   node packages/cli/test/e2e/blockfrost-stub.ts --port 8080 --genesis-port 8081 --limit-port 8082 --genesis 0x…

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';

const { values: o } = parseArgs({
  options: {
    port: { type: 'string', default: '8080' },
    'genesis-port': { type: 'string', default: '8081' },
    'limit-port': { type: 'string', default: '8082' },
    genesis: { type: 'string' },
    'too-many': { type: 'string', default: '3' },
    'rpc-upstream': { type: 'string', default: 'http://node:9944' },
    'indexer-upstream': { type: 'string', default: 'http://indexer:8088/api/v4/graphql' },
  },
});
const TOKEN = process.env.STUB_TOKEN ?? '';
if (TOKEN.length < 8) throw new Error('STUB_TOKEN (the expected project token) is required');
const stats = { withToken: 0, withoutToken: 0, wrongToken: 0, limited: 0 };
let tooMany = Number(o['too-many']);

const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
const forbidden = (res: ServerResponse) =>
  res
    .writeHead(403, { 'content-type': 'application/json' })
    .end('{"status_code":403,"error":"Forbidden","message":"Invalid project token."}');

/** Checks the token; counts; logs the path only. */
function admit(req: IncomingMessage, port: string): URL | undefined {
  const u = new URL(req.url ?? '/', 'http://stub');
  const t = u.searchParams.get('project_id');
  if (t === null) stats.withoutToken++;
  else if (t !== TOKEN) stats.wrongToken++;
  else stats.withToken++;
  log(`:${port} ${req.method} ${u.pathname} ${t === null ? 'no-token' : t === TOKEN ? 'token' : 'wrong-token'}`);
  return t === TOKEN ? u : undefined;
}

function upstreamOf(path: string): { http: string; ws: string } | undefined {
  const rpc = o['rpc-upstream']!;
  const idx = o['indexer-upstream']!;
  if (path === '/rpc' || path === '/rpc/') return { http: rpc, ws: rpc.replace(/^http/u, 'ws') };
  if (path === '/api/v0/ws') return { http: '', ws: `${idx.replace(/^http/u, 'ws')}/ws` };
  if (path === '/api/v0' || path === '/api/v0/') return { http: idx, ws: '' };
  return undefined;
}

function handler(port: string, mode: 'plain' | 'genesis' | 'limit') {
  return (req: IncomingMessage, res: ServerResponse) => {
    const u = admit(req, port);
    if (!u) return forbidden(res);
    if (u.pathname === '/stub-stats') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats));
    if (mode === 'limit' && tooMany > 0) {
      tooMany--;
      stats.limited++;
      return res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }).end('{"status_code":429}');
    }
    const up = upstreamOf(u.pathname);
    if (!up?.http || req.method !== 'POST') return res.writeHead(404).end();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (mode === 'genesis' && o.genesis) {
        try {
          const j = JSON.parse(body.toString('utf8')) as { id?: unknown; method?: string; params?: unknown[] };
          if (j.method === 'chain_getBlockHash' && Array.isArray(j.params) && j.params[0] === 0)
            return res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: o.genesis }));
        } catch {
          /* forward as is */
        }
      }
      const f = httpRequest(
        up.http,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } },
        (r) => {
          res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json' });
          r.pipe(res);
        },
      );
      f.on('error', (e) => res.writeHead(502).end(JSON.stringify({ error: e.message })));
      f.end(body);
    });
  };
}

const wss = new WebSocketServer({ noServer: true });
function upgrade(port: string) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const u = admit(req, port);
    const up = u ? upstreamOf(u.pathname) : undefined;
    if (!u || !up?.ws) {
      socket.end(`HTTP/1.1 ${u ? 404 : 403} ${u ? 'Not Found' : 'Forbidden'}\r\n\r\n`);
      return;
    }
    const protocols = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(up.ws, protocols);
      const pending: { data: unknown; binary: boolean }[] = [];
      client.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data as Buffer, { binary });
        else pending.push({ data, binary });
      });
      upstream.on('open', () => {
        for (const m of pending.splice(0)) upstream.send(m.data as Buffer, { binary: m.binary });
      });
      upstream.on('message', (data, binary) => client.readyState === WebSocket.OPEN && client.send(data as Buffer, { binary }));
      const closeBoth = () => {
        if (client.readyState === WebSocket.OPEN) client.close();
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      };
      client.on('close', closeBoth);
      upstream.on('close', closeBoth);
      upstream.on('error', closeBoth);
      client.on('error', closeBoth);
    });
  };
}

for (const [port, mode] of [
  [o.port!, 'plain'],
  [o['genesis-port']!, 'genesis'],
  [o['limit-port']!, 'limit'],
] as const) {
  const s = createServer(handler(port, mode));
  s.on('upgrade', upgrade(port));
  s.listen(Number(port), '0.0.0.0', () => log(`listening on :${port} (${mode})`));
}
process.on('SIGTERM', () => {
  log(`stats ${JSON.stringify(stats)}`);
  process.exit(0);
});
