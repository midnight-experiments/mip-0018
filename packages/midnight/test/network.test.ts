// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DustAddress,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, TokenError } from '../src/http.ts';
import {
  checkIdentity,
  connectUrl,
  connectUrls,
  httpFor,
  IdentityError,
  isPublicHost,
  PROFILE_IDS,
  ProfileError,
  PUBLIC_NETWORKS,
  resolveProfile,
  undeployedProfile,
  withChainInstance,
  type PublicNetworkId,
} from '../src/network.ts';
import { redactUrl, redactUrls, removeSecrets, scrubSecrets } from '../src/redact.ts';
import { listMetadata } from '../src/list.ts';

type ToolchainNetwork = {
  networkId: string;
  chain?: string;
  genesisHash?: string;
  indexer?: string;
  indexerWs?: string;
  rpc?: string;
  rpcWs?: string;
  token?: string;
  addressPrefixes: { unshielded: string; shielded: string; dust: string };
};
const toolchain = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'toolchain.json'), 'utf8')) as {
  networks: Record<string, ToolchainNetwork | string>;
};

const SENTINEL = 'SentinelToken0123456789abcdef';
const PUBLIC: PublicNetworkId[] = ['preview', 'preprod', 'mainnet'];
const tokenEnv = { MIP0018_BLOCKFROST_PREPROD: SENTINEL, MIP0018_BLOCKFROST_MAINNET: SENTINEL };

const rpcAnswer = (result: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })) as typeof fetch;

describe('network profiles', () => {
  it('the profile ids are exactly undeployed, preview, preprod and mainnet', () => {
    expect([...PROFILE_IDS]).toEqual(['undeployed', 'preview', 'preprod', 'mainnet']);
    expect(
      Object.keys(toolchain.networks)
        .filter((k) => !k.startsWith('$'))
        .sort(),
    ).toEqual([...PROFILE_IDS].sort());
  });

  it('public constants equal toolchain.json', () => {
    for (const id of PUBLIC) {
      const t = toolchain.networks[id] as ToolchainNetwork;
      const n = PUBLIC_NETWORKS[id];
      expect(n).toEqual({
        networkId: t.networkId,
        chain: t.chain,
        genesisHash: t.genesisHash,
        indexer: t.indexer,
        indexerWs: t.indexerWs,
        rpc: t.rpc,
        rpcWs: t.rpcWs,
        ...(t.token ? { tokenVariable: t.token } : {}),
        addressPrefixes: t.addressPrefixes,
      });
    }
    const local = toolchain.networks.undeployed as ToolchainNetwork;
    const p = undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: 'http://node:9944' });
    expect(p.networkId).toBe(local.networkId);
    expect(p.addressPrefixes).toEqual(local.addressPrefixes);
  });

  it("address prefixes are the wallet SDK's encoding of each network id", () => {
    const key = (b: number) => Buffer.alloc(32, b);
    const prefixOf = (s: string) => s.slice(0, s.lastIndexOf('1'));
    for (const id of PROFILE_IDS) {
      const p =
        id === 'undeployed'
          ? undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: 'http://node:9944' })
          : resolveProfile(id, {}, tokenEnv);
      expect(prefixOf(UnshieldedAddress.codec.encode(p.networkId, new UnshieldedAddress(key(1))).asString())).toBe(
        p.addressPrefixes.unshielded,
      );
      const shielded = new ShieldedAddress(new ShieldedCoinPublicKey(key(2)), new ShieldedEncryptionPublicKey(key(3)));
      expect(prefixOf(ShieldedAddress.codec.encode(p.networkId, shielded).asString())).toBe(p.addressPrefixes.shielded);
      expect(prefixOf(DustAddress.codec.encode(p.networkId, new DustAddress(5n)).asString())).toBe(p.addressPrefixes.dust);
    }
  });

  it('public profiles: pinned genesis cannot be overridden; public rate bound on; URLs may be overridden', () => {
    for (const id of PUBLIC) {
      const p = resolveProfile(id, {}, tokenEnv);
      expect(p).toMatchObject({ id, networkId: id, genesisHash: PUBLIC_NETWORKS[id].genesisHash, public: true });
      expect(p.minIntervalMs).toBeGreaterThan(0);
      expect(() => resolveProfile(id, { genesisHash: '0x' + '00'.repeat(32) }, tokenEnv)).toThrow(/pinned/);
      const o = resolveProfile(id, { rpc: 'http://127.0.0.1:12001', indexer: 'http://127.0.0.1:12002/api/v0' }, tokenEnv);
      expect(o).toMatchObject({ rpcWs: 'ws://127.0.0.1:12001', indexerWs: 'ws://127.0.0.1:12002/api/v0/ws' });
      expect(o.genesisHash).toBe(PUBLIC_NETWORKS[id].genesisHash);
    }
    expect(resolveProfile('preview', {}, {}).tokenSource).toBeUndefined();
  });

  it('any other id is unknown; the error lists the valid ids', () => {
    for (const id of ['testnet-02', 'local', 'devnet', '']) {
      expect(() => resolveProfile(id, {}, tokenEnv)).toThrow(ProfileError);
      expect(() => resolveProfile(id, {}, tokenEnv)).toThrow(/expected one of: undeployed, preview, preprod, mainnet/);
    }
  });

  it('preprod / mainnet without a token stop before any request and name the variable', () => {
    expect(() => resolveProfile('preprod', {}, {})).toThrow(/MIP0018_BLOCKFROST_PREPROD/);
    expect(() => resolveProfile('mainnet', {}, { MIP0018_BLOCKFROST_PREPROD: SENTINEL })).toThrow(/MIP0018_BLOCKFROST_MAINNET/);
    expect(() => resolveProfile('preprod', {}, { MIP0018_BLOCKFROST_PREPROD: '  ' })).toThrow(/nothing was sent/);
    expect(() => resolveProfile('preprod', {}, { MIP0018_BLOCKFROST_PREPROD: 'abc?x=1&y' })).toThrow(/letters and digits/);
    expect(() => resolveProfile('preview', { tokenFile: '/nonexistent' }, {})).toThrow(/takes no Blockfrost token/);
  });

  it('a token file must be 0600; its token is used like the variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-'));
    try {
      const f = join(dir, 'preprod.token');
      writeFileSync(f, `${SENTINEL}\n`);
      chmodSync(f, 0o644);
      expect(() => resolveProfile('preprod', { tokenFile: f }, {})).toThrow(/chmod 600/);
      chmodSync(f, 0o600);
      const p = resolveProfile('preprod', { tokenFile: f }, {});
      expect(p.tokenSource).toBe(`--blockfrost-token-file ${f}`);
      expect(connectUrl(p, p.rpc)).toContain(SENTINEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the token is never part of the profile object; only connectUrl adds it', () => {
    const p = resolveProfile('preprod', {}, tokenEnv);
    expect(JSON.stringify(p)).not.toContain(SENTINEL);
    expect(p.tokenSource).toBe('MIP0018_BLOCKFROST_PREPROD');
    for (const u of [p.indexer, p.indexerWs, p.rpc, p.rpcWs]) expect(u).not.toContain('?');
    const c = connectUrls(p);
    expect(new URL(c.rpc).searchParams.get('project_id')).toBe(SENTINEL);
    expect(new URL(c.indexerWs).searchParams.get('project_id')).toBe(SENTINEL);
    expect(redactUrl(c.indexer)).toBe('https://midnight-preprod.blockfrost.io/api/v0');
    const copy = withChainInstance(p, '0x' + '01'.repeat(32));
    expect(connectUrl(copy, copy.rpc)).toContain(SENTINEL);
    expect(connectUrl(resolveProfile('preview', {}, {}), PUBLIC_NETWORKS.preview.rpc)).toBe(PUBLIC_NETWORKS.preview.rpc);
  });

  it('URLs with a query string, fragment or credentials are refused (a token goes in its variable, never in a URL)', () => {
    expect(() => resolveProfile('preprod', { indexer: `http://127.0.0.1:1/api/v0?project_id=${SENTINEL}` }, tokenEnv)).toThrow(
      /no query string/,
    );
    try {
      resolveProfile('preprod', { rpc: `http://127.0.0.1:1/?project_id=${SENTINEL}` }, tokenEnv);
    } catch (e) {
      expect((e as Error).message).not.toContain(SENTINEL);
    }
    expect(() => undeployedProfile({ indexer: 'http://u:p@indexer:8088/g', rpc: 'http://node:9944' })).toThrow(/credentials/);
  });

  it('undeployed: every URL is required, never a default', () => {
    expect(() => undeployedProfile({})).toThrow(/indexer URL is required/);
    expect(() => undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql' })).toThrow(/node RPC URL is required/);
    expect(() => resolveProfile('undeployed', {}, {})).toThrow(ProfileError);
    const p = resolveProfile(
      'undeployed',
      {},
      { MIP0018_INDEXER_URL: 'http://127.0.0.1:12345/api/v4/graphql', MIP0018_NODE_URL: 'http://127.0.0.1:12346' },
    );
    expect(p.indexerWs).toBe('ws://127.0.0.1:12345/api/v4/graphql/ws');
    expect(p.rpcWs).toBe('ws://127.0.0.1:12346');
    expect(p.public).toBe(false);
    for (const u of [p.indexer, p.indexerWs, p.rpc, p.rpcWs]) expect(isPublicHost(u)).toBe(false);
    expect(() => undeployedProfile({ indexer: 'http://indexer:8088/g', rpc: 'http://node:9944', tokenFile: '/x' })).toThrow(
      /no Blockfrost/,
    );
  });

  it('undeployed refuses URLs and genesis hashes of the public networks', () => {
    for (const id of PUBLIC) {
      const n = PUBLIC_NETWORKS[id];
      expect(() => undeployedProfile({ indexer: n.indexer, rpc: 'http://node:9944' })).toThrow(/public network/);
      expect(() => undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: n.rpc })).toThrow(/public network/);
      expect(() => undeployedProfile({ indexer: 'http://indexer:8088/g', rpc: 'http://node:9944', rpcWs: n.rpcWs })).toThrow(
        /public network/,
      );
      expect(() => undeployedProfile({ indexer: 'http://indexer:8088/g', rpc: 'http://node:9944', genesisHash: n.genesisHash })).toThrow(
        new RegExp(`${id} genesis`),
      );
    }
    expect(() => undeployedProfile({ indexer: 'http://x.midnight.network/g', rpc: 'http://node:9944' })).toThrow(/public network/);
    expect(() => undeployedProfile({ indexer: 'http://midnight-preview.blockfrost.io/g', rpc: 'http://node:9944' })).toThrow(
      /public network/,
    );
  });

  it('identity: wrong genesis aborts naming both; undeployed refuses every public genesis; chain instance = block 1', async () => {
    const preview = resolveProfile('preview', {}, {});
    const wrong = new HttpClient({ fetch: rpcAnswer('0x' + 'ab'.repeat(32)), attempts: 1 });
    await expect(checkIdentity(preview, wrong)).rejects.toThrow(IdentityError);
    await expect(checkIdentity(preview, new HttpClient({ fetch: rpcAnswer('0x' + 'ab'.repeat(32)), attempts: 1 }))).rejects.toThrow(
      `wrong chain: node genesis 0x${'ab'.repeat(32)}, expected ${PUBLIC_NETWORKS.preview.genesisHash} (preview)`,
    );
    const right = new HttpClient({ fetch: rpcAnswer(PUBLIC_NETWORKS.preview.genesisHash), attempts: 1 });
    await expect(checkIdentity(preview, right)).resolves.toBe(PUBLIC_NETWORKS.preview.genesisHash);
    const local = undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: 'http://node:9944' });
    for (const id of PUBLIC)
      await expect(
        checkIdentity(local, new HttpClient({ fetch: rpcAnswer(PUBLIC_NETWORKS[id].genesisHash), attempts: 1 })),
      ).rejects.toThrow(new RegExp(`${id} genesis`));
    await expect(checkIdentity(local, new HttpClient({ fetch: rpcAnswer('0x' + '12'.repeat(32)), attempts: 1 }))).resolves.toBe(
      '0x' + '12'.repeat(32),
    );
    const pinned = undeployedProfile({
      indexer: 'http://indexer:8088/api/v4/graphql',
      rpc: 'http://node:9944',
      genesisHash: '0x' + '34'.repeat(32),
    });
    await expect(checkIdentity(pinned, new HttpClient({ fetch: rpcAnswer('0x' + '12'.repeat(32)), attempts: 1 }))).rejects.toThrow(
      /wrong chain/,
    );
    // chain instance: genesis 0x12…, block 1 must be 0x56…
    const byHeight = (one: string): typeof fetch =>
      (async (_u: string | URL | Request, init?: RequestInit) => {
        const h = (JSON.parse(String(init?.body)) as { params: number[] }).params[0];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h === 0 ? '0x' + '12'.repeat(32) : one }), { status: 200 });
      }) as typeof fetch;
    const inst = withChainInstance(local, '0x' + '56'.repeat(32));
    await expect(checkIdentity(inst, new HttpClient({ fetch: byHeight('0x' + '56'.repeat(32)), attempts: 1 }))).resolves.toBe(
      '0x' + '12'.repeat(32),
    );
    await expect(checkIdentity(inst, new HttpClient({ fetch: byHeight('0x' + '78'.repeat(32)), attempts: 1 }))).rejects.toThrow(
      /another instance of undeployed: node block 1 is 0x7878.*expected 0x5656/,
    );
  });
});

describe('redaction', () => {
  it('redactUrl cuts query string, fragment and credentials, nothing else', () => {
    expect(redactUrl(`https://rpc.midnight-preprod.blockfrost.io/?project_id=${SENTINEL}`)).toBe(
      'https://rpc.midnight-preprod.blockfrost.io/',
    );
    expect(redactUrl(`wss://midnight-mainnet.blockfrost.io/api/v0/ws?project_id=${SENTINEL}#x`)).toBe(
      'wss://midnight-mainnet.blockfrost.io/api/v0/ws',
    );
    expect(redactUrl('http://user:pw@host:1/a')).toBe('http://host:1/a');
    expect(redactUrl('http://node:9944')).toBe('http://node:9944');
  });

  it('redactUrls cleans every URL inside a text, and any project_id assignment', () => {
    const t = `fetch https://a.io/x?project_id=${SENTINEL} failed; then wss://b.io/ws?a=1&project_id=${SENTINEL}; raw "/?project_id=${SENTINEL}"`;
    const r = redactUrls(t);
    expect(r).not.toContain(SENTINEL);
    expect(r).toContain('https://a.io/x failed');
    expect(r).toContain('then wss://b.io/ws raw');
  });

  it('scrubSecrets / removeSecrets remove a registered token anywhere (profiles register theirs)', () => {
    resolveProfile('preprod', {}, tokenEnv);
    expect(removeSecrets(`token ${SENTINEL} in prose`)).toBe('token [redacted] in prose');
    expect(scrubSecrets(`x ${SENTINEL} https://h/?q=1`)).toBe('x [redacted] https://h/');
    expect(removeSecrets('https://example.org/acme.png?size=2')).toBe('https://example.org/acme.png?size=2'); // values untouched
  });
});

/** A Blockfrost-like stub on 127.0.0.1: requires `project_id`, answers 200 / 403 / 429 (and a node + indexer). */
function blockfrostStub(o: { token: string; genesis: string; tooMany?: number }): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  let tooMany = o.tooMany ?? 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub');
    seen.push(`${req.method} ${u.pathname} ${u.searchParams.has('project_id') ? 'token' : 'no-token'}`);
    if (u.searchParams.get('project_id') !== o.token) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end('{"status_code":403,"error":"Forbidden","message":"Invalid project token."}');
      return;
    }
    if (tooMany > 0) {
      tooMany--;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }).end('{"status_code":429}');
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const b = JSON.parse(body || '{}') as { method?: string; params?: unknown[]; query?: string };
      const ok = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (b.method === 'chain_getBlockHash') {
        const h = (b.params as number[])[0]!;
        return ok({ jsonrpc: '2.0', id: 1, result: h === 0 ? o.genesis : '0x' + h.toString(16).padStart(64, '0') });
      }
      if (b.method === 'chain_getFinalizedHead') return ok({ jsonrpc: '2.0', id: 1, result: '0x' + (100).toString(16).padStart(64, '0') });
      if (b.method === 'chain_getHeader')
        return ok({ jsonrpc: '2.0', id: 1, result: { number: '0x64', parentHash: '0x' + '00'.repeat(32) } });
      if (b.query?.includes('contractEvents')) return ok({ data: { contractEvents: [] } });
      if (b.query?.includes('block'))
        return ok({ data: { block: { height: 100, hash: (100).toString(16).padStart(64, '0'), timestamp: 0 } } });
      return ok({ errors: [{ message: 'unknown query' }] });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })),
  );
}

describe('preprod and mainnet against a local Blockfrost stub', () => {
  const stubs: Server[] = [];
  afterAll(() => stubs.forEach((s) => s.close()));
  let ok: { url: string; seen: string[] };
  beforeAll(async () => {
    const s = await blockfrostStub({ token: SENTINEL, genesis: PUBLIC_NETWORKS.preprod.genesisHash });
    stubs.push(s.server);
    ok = s;
  });
  const profile = (id: 'preprod' | 'mainnet', url: string, token = SENTINEL) =>
    resolveProfile(id, { rpc: url, indexer: `${url}/api/v0` }, { MIP0018_BLOCKFROST_PREPROD: token, MIP0018_BLOCKFROST_MAINNET: token });

  it('200 with project_id: identity and list run; every request carried the token', async () => {
    const p = profile('preprod', ok.url);
    const r = await listMetadata({ profile: p, contract: 'cc'.repeat(32), http: new HttpClient({ attempts: 1 }) });
    expect(r.network).toEqual({ id: 'preprod', genesisHash: PUBLIC_NETWORKS.preprod.genesisHash, indexer: `${ok.url}/api/v0` });
    expect(r.counts.events).toBe(0);
    expect(ok.seen.length).toBeGreaterThan(3);
    expect(ok.seen.every((x) => x.endsWith(' token'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it('403 (wrong token): a TokenError naming the variable, without the token or the query string', async () => {
    const p = profile('preprod', ok.url, 'WrongToken0123456789');
    const err = await checkIdentity(p, httpFor(p)).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TokenError);
    expect(err.message).toMatch(
      /HTTP 403 from http:\/\/127\.0\.0\.1:\d+\/: the Blockfrost project token from MIP0018_BLOCKFROST_PREPROD was refused/,
    );
    expect(err.message).not.toContain('WrongToken0123456789');
    expect(err.message).not.toContain('?');
  });

  it('403 without project_id (the stub refuses a request that carries no token)', async () => {
    const res = await fetch(`${ok.url}/`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('mainnet: wrong genesis behind the stub (a preprod node) is refused', async () => {
    const p = profile('mainnet', ok.url);
    await expect(checkIdentity(p, new HttpClient({ attempts: 1 }))).rejects.toThrow(/wrong chain: .*expected 0x1941ca8e.*\(mainnet\)/);
  });

  it('429: the client pauses (Retry-After), then succeeds; no request while paused', async () => {
    const s = await blockfrostStub({ token: SENTINEL, genesis: PUBLIC_NETWORKS.mainnet.genesisHash, tooMany: 2 });
    stubs.push(s.server);
    const p = profile('mainnet', s.url);
    const http = new HttpClient({ minIntervalMs: 50, attempts: 4 });
    const started = Date.now();
    await expect(checkIdentity(p, http)).resolves.toBe(PUBLIC_NETWORKS.mainnet.genesisHash);
    expect(http.rateLimited).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900); // two Retry-After: 1 pauses
    expect(s.seen).toHaveLength(3);
  });

  it('429 on every attempt: a rate-limit error after the attempt budget, without the token', async () => {
    const s = await blockfrostStub({ token: SENTINEL, genesis: PUBLIC_NETWORKS.preprod.genesisHash, tooMany: 99 });
    stubs.push(s.server);
    const p = profile('preprod', s.url);
    const http = new HttpClient({ attempts: 2, sleep: async () => {} });
    const err = await checkIdentity(p, http).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/HTTP 429 .*rate limited on all 2 attempts/);
    expect(err.message).not.toContain(SENTINEL);
  });
});

describe('HttpClient', () => {
  it('retries 429/503 with backoff and honours the rate bound', async () => {
    const statuses = [429, 503, 200];
    const sleeps: number[] = [];
    let calls = 0;
    const http = new HttpClient({
      minIntervalMs: 0,
      fetch: (async () => {
        const s = statuses[calls++] ?? 200;
        return new Response(JSON.stringify({ ok: s }), { status: s, headers: s === 429 ? { 'retry-after': '2' } : {} });
      }) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(http.postJson('http://x', {})).resolves.toEqual({ ok: 200 });
    expect(calls).toBe(3);
    expect(sleeps[0]).toBeGreaterThan(1900); // the 429 pause: Retry-After wins over the 500 ms backoff
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
    expect(sleeps[1]).toBe(1000);
  });

  it('does not retry a 400 and gives up after the attempt budget', async () => {
    let calls = 0;
    const bad = new HttpClient({
      fetch: (async () => (calls++, new Response('no', { status: 400 }))) as typeof fetch,
      sleep: async () => {},
    });
    await expect(bad.postJson('http://x', {})).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
    calls = 0;
    const down = new HttpClient({
      attempts: 3,
      fetch: (async () => (calls++, new Response('', { status: 502 }))) as typeof fetch,
      sleep: async () => {},
    });
    await expect(down.postJson('http://x', {})).rejects.toThrow(/HTTP 502/);
    expect(calls).toBe(3);
  });

  it('a network error names the URL without its query string', async () => {
    const http = new HttpClient({
      attempts: 1,
      fetch: (async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }) as typeof fetch,
    });
    await expect(http.postJson(`http://h:1/?project_id=${SENTINEL}`, {})).rejects.toThrow(
      'request to http://h:1/ failed: fetch failed (ECONNREFUSED)',
    );
  });

  it('spaces request starts by minIntervalMs', async () => {
    const starts: number[] = [];
    const http = new HttpClient({
      minIntervalMs: 60,
      fetch: (async () => (starts.push(Date.now()), new Response('{}', { status: 200 }))) as typeof fetch,
    });
    await Promise.all([http.postJson('http://x', 1), http.postJson('http://x', 2), http.postJson('http://x', 3)]);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(55);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(55);
  });
});
