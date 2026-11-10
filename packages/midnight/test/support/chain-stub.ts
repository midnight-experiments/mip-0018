// SPDX-License-Identifier: Apache-2.0
//
// A local node + indexer stub on 127.0.0.1 for identity tests: the node answers `chain_getBlockHash(0)` with a given
// genesis and `chain_getBlockHash(1)` with a given block 1 (the chain instance); the indexer answers every query with
// an empty-but-valid body (or a given handler's). Every request is counted per endpoint, so a test can assert that a
// command refused the chain before it read anything from the indexer. WebSocket upgrades are counted and closed.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ChainStub {
  url: string;
  rpc: string;
  indexer: string;
  counts: { rpc: number; indexer: number; upgrades: number };
  /** JSON-RPC methods (with their first parameter) in the order they arrived. */
  rpcCalls: string[];
  close(): Promise<void>;
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

export async function chainStub(o: {
  genesis: string;
  blockOne: string;
  indexer?: (body: { query?: string; variables?: unknown }, req: IncomingMessage) => unknown;
}): Promise<ChainStub> {
  const counts = { rpc: 0, indexer: 0, upgrades: 0 };
  const rpcCalls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const ok = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      const path = new URL(req.url ?? '/', 'http://stub').pathname;
      const b = JSON.parse(body || '{}') as { method?: string; params?: unknown[]; query?: string; variables?: unknown };
      if (path.startsWith('/rpc')) {
        counts.rpc++;
        rpcCalls.push(`${b.method}${b.params?.length ? `(${String(b.params[0])})` : ''}`);
        const result = (() => {
          switch (b.method) {
            case 'chain_getBlockHash': {
              const h = Number(b.params?.[0]);
              return h === 0 ? o.genesis : h === 1 ? o.blockOne : hash(h);
            }
            case 'chain_getFinalizedHead':
              return hash(100);
            case 'chain_getHeader':
              return { number: '0x64', parentHash: hash(99) };
            default:
              return 'stub';
          }
        })();
        return ok({ jsonrpc: '2.0', id: 1, result });
      }
      if (path.startsWith('/idx')) {
        counts.indexer++;
        return ok(
          o.indexer?.(b, req) ?? {
            data: {
              block: { height: 100, hash: hash(100).slice(2), timestamp: 0 },
              contractEvents: [],
              transactions: [],
              contractAction: null,
            },
          },
        );
      }
      res.writeHead(404).end();
    });
  });
  server.on('upgrade', (_req, socket) => {
    counts.upgrades++;
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    rpc: `${url}/rpc`,
    indexer: `${url}/idx`,
    counts,
    rpcCalls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
