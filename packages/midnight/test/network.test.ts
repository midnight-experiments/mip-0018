// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.ts';
import {
  checkIdentity,
  IdentityError,
  isPublicHost,
  ProfileError,
  resolveProfile,
  STAGENET,
  stagenetProfile,
  undeployedProfile,
} from '../src/network.ts';

const toolchain = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'toolchain.json'), 'utf8')) as {
  networks: { stagenet: { networkId: string; genesisHash: string; indexer: string; indexerWs: string; rpc: string } };
};

const rpcAnswer = (result: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })) as typeof fetch;

describe('network profiles', () => {
  it('Stagenet constants equal toolchain.json', () => {
    const s = toolchain.networks.stagenet;
    expect(STAGENET.networkId).toBe(s.networkId);
    expect(STAGENET.genesisHash).toBe(s.genesisHash);
    expect(STAGENET.indexer).toBe(s.indexer);
    expect(STAGENET.indexerWs).toBe(s.indexerWs);
    expect(STAGENET.rpc).toBe(s.rpc);
  });

  it('stagenet: pinned genesis cannot be overridden; public rate bound on', () => {
    const p = stagenetProfile();
    expect(p.public).toBe(true);
    expect(p.minIntervalMs).toBeGreaterThan(0);
    expect(() => stagenetProfile({ genesisHash: '0x' + '00'.repeat(32) })).toThrow(ProfileError);
  });

  it('undeployed: every URL is required, never a Stagenet default', () => {
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
  });

  it('undeployed refuses URLs of public networks', () => {
    expect(() => undeployedProfile({ indexer: STAGENET.indexer, rpc: 'http://node:9944' })).toThrow(/public network/);
    expect(() => undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: STAGENET.rpc })).toThrow(/public network/);
    expect(() => undeployedProfile({ indexer: 'http://x.midnight.network/g', rpc: 'http://node:9944' })).toThrow(/public network/);
  });

  it('identity: wrong genesis aborts; undeployed refuses the Stagenet genesis', async () => {
    const wrong = new HttpClient({ fetch: rpcAnswer('0x' + 'ab'.repeat(32)), attempts: 1 });
    await expect(checkIdentity(stagenetProfile(), wrong)).rejects.toThrow(IdentityError);
    const right = new HttpClient({ fetch: rpcAnswer(STAGENET.genesisHash), attempts: 1 });
    await expect(checkIdentity(stagenetProfile(), right)).resolves.toBe(STAGENET.genesisHash);
    const local = undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: 'http://node:9944' });
    await expect(checkIdentity(local, new HttpClient({ fetch: rpcAnswer(STAGENET.genesisHash), attempts: 1 }))).rejects.toThrow(
      /Stagenet genesis/,
    );
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
    expect(sleeps[0]).toBe(2000); // Retry-After wins over the 500 ms backoff
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
