// SPDX-License-Identifier: Apache-2.0
//
// scripts/inspect.ts checks the node's identity before its first indexer read and never prints a token: against a
// local node + indexer stub (127.0.0.1) it refuses a public network's genesis on `undeployed`, refuses another chain
// instance than its run record (or the record's case folder) names, and an indexer error that echoes the
// token-bearing URL and the token reaches neither stdout nor stderr.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_NETWORKS } from '@mip0018/midnight';
import { chainStub, type ChainStub } from '../../../packages/midnight/test/support/chain-stub.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'inspect.ts');
const TOKEN = 'FakeTokenInspect0123456789';
const G = `0x${'12'.repeat(32)}`;
const C1 = `0x${'c1'.repeat(32)}`;
const C2 = `0x${'c2'.repeat(32)}`;
const CONTRACT = 'ab'.repeat(32);

function inspect(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(base)) if (k.startsWith('MIP0018_')) delete base[k];
    const p = spawn(process.execPath, [script, ...args], { env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'mip0018-inspect-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const stubs: ChainStub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});
const endpoints = (s: ChainStub) => ({ MIP0018_NODE_URL: s.rpc, MIP0018_INDEXER_URL: s.indexer });

describe('scripts/inspect.ts', () => {
  it('undeployed at a node with a public genesis: refused, no indexer read', async () => {
    const s = await chainStub({ genesis: PUBLIC_NETWORKS.preview.genesisHash, blockOne: C1 });
    stubs.push(s);
    const r = await inspect(['--network', 'undeployed', '--contract', CONTRACT], endpoints(s));
    expect(r.stderr).toMatch(/IdentityError: the undeployed profile points at a node with the preview genesis/u);
    expect(r.status).toBe(1);
    expect(s.counts.indexer).toBe(0);
  });

  it('--record names block 1 (in the record, or in the network file of its case folder): another block 1 → refused, no indexer read', async () => {
    const s = await chainStub({ genesis: G, blockOne: C2 });
    stubs.push(s);
    const write = (path: string, network: Record<string, string>) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify({ kind: 'mip0018-run-record', schema: 1, network, contract: { address: CONTRACT }, steps: [] }));
      return path;
    };
    const own = write(join(tmp, 'own', 'record.json'), { id: 'undeployed', genesisHash: G, chainInstance: C1 });
    const a = await inspect(['--network', 'undeployed', '--record', own], endpoints(s));
    expect(a.stderr).toMatch(/another instance of undeployed: node block 1 is 0xc2c2.*expected 0xc1c1/u);
    expect(a.status).toBe(1);
    const net = join(tmp, 'net');
    mkdirSync(join(net, 'cases', 'U1'), { recursive: true });
    writeFileSync(join(net, 'network.json'), JSON.stringify({ network: { id: 'undeployed', genesisHash: G, chainInstance: C1 } }));
    const inCase = write(join(net, 'cases', 'U1', 'record.json'), { id: 'undeployed', genesisHash: G });
    const b = await inspect(['--network', 'undeployed', '--record', inCase], endpoints(s));
    expect(b.stderr).toMatch(/another instance of undeployed/u);
    expect(b.status).toBe(1);
    expect(s.counts.indexer).toBe(0);
  });

  it('an indexer error that echoes the token-bearing URL and the token reaches neither stdout nor stderr', async () => {
    const s = await chainStub({
      genesis: G,
      blockOne: C1,
      indexer: (_b, req) => ({ errors: [{ message: `denied ${req.url} for token ${TOKEN}`, extensions: { project_id: TOKEN } }] }),
    });
    stubs.push(s);
    const r = await inspect(['--network', 'undeployed', '--contract', CONTRACT], { ...endpoints(s), MIP0018_TEST_UNDEPLOYED_TOKEN: TOKEN });
    expect(s.counts.indexer).toBe(1);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^inspect: IndexerError: indexer GraphQL error/mu);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});
