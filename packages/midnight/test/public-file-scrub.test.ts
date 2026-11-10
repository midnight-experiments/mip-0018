// SPDX-License-Identifier: Apache-2.0
//
// Every public JSON file a tool writes from what a node or an indexer answered is free of the project token: the
// scanner state (a transaction hash and a decode error the indexer caused) and the network file that
// `deployments/tools/network-identity.ts --append` writes (the node's version, name and runtime), against a local stub
// that echoes the token the request carried. A process that holds a token never prints it.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.ts';
import { PUBLIC_NETWORKS, publicProfile } from '../src/network.ts';
import { scan, statePath } from '../src/scanner.ts';
import { chainStub, type ChainStub } from './support/chain-stub.ts';

const TOKEN = 'FakeTokenPublicFile0123456789';
const repo = join(import.meta.dirname, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'mip0018-public-file-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const stubs: ChainStub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});
const hash = (n: number) => n.toString(16).padStart(64, '0');
const ONE = `0x${'c1'.repeat(32)}`;

/** Runs a node process without blocking this event loop (the stub runs here); killed after `timeoutMs`. */
function run(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(clean)) if (k.startsWith('MIP0018_')) delete clean[k];
    const p = spawn(process.execPath, args, { env: { ...clean, ...env }, cwd: repo });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe('public files hold no token', () => {
  it('the scanner state: a transaction hash and a decode error the indexer caused', async () => {
    const s = await chainStub({
      genesis: PUBLIC_NETWORKS.preprod.genesisHash,
      blockOne: ONE,
      indexer: (b) =>
        (b.variables as { h?: number } | undefined)?.h === undefined
          ? { data: { block: { height: 101, hash: hash(101), timestamp: 0 } } }
          : {
              data: {
                block: {
                  height: 100,
                  hash: hash(100),
                  timestamp: 0,
                  parent: { hash: hash(99) },
                  transactions: [
                    {
                      __typename: 'RegularTransaction',
                      id: 1,
                      hash: TOKEN,
                      raw: `00${TOKEN}`,
                      contractActions: [{ __typename: 'ContractCall', address: 'ab'.repeat(32) }],
                      transactionResult: { status: 'SUCCESS', segments: [] },
                    },
                  ],
                },
              },
            },
    });
    stubs.push(s);
    const profile = publicProfile('preprod', { rpc: s.rpc, indexer: s.indexer, minIntervalMs: 0 }, { MIP0018_BLOCKFROST_PREPROD: TOKEN });
    const dir = join(tmp, 'scan');
    const r = await scan({ profile, stateDir: dir, fromHeight: 100, toHeight: 100, poll: true, http: new HttpClient({ attempts: 1 }) });
    expect(s.queries.some((q) => q.includes(`project_id=${TOKEN}`))).toBe(true);
    expect(r.state.stats.decodeErrors).toBe(1);
    const text = readFileSync(statePath(dir), 'utf8');
    expect(text).not.toContain(TOKEN);
    expect((JSON.parse(text) as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('the network file network-identity.ts appends to: the node and indexer answers', async () => {
    const s = await chainStub({
      genesis: PUBLIC_NETWORKS.preprod.genesisHash,
      blockOne: ONE,
      rpc: (method) =>
        ({
          system_chain: 'Midnight Preprod',
          system_name: `node ${TOKEN}`,
          system_version: `2.1.101 (${TOKEN})`,
          state_getRuntimeVersion: { specName: `midnight-${TOKEN}`, specVersion: 1, transactionVersion: 1, stateVersion: 1 },
        })[method],
      indexer: () => ({ data: { block: { height: 100, hash: TOKEN, timestamp: 0, protocolVersion: 1 } } }),
    });
    stubs.push(s);
    const file = join(tmp, 'network.json');
    const r = await run(
      [
        '--import',
        join(import.meta.dirname, 'support', 'redirect-fetch.mjs'),
        join(repo, 'deployments', 'tools', 'network-identity.ts'),
        '--network',
        'preprod',
        '--append',
        file,
        '--label',
        'stub',
      ],
      {
        MIP0018_BLOCKFROST_PREPROD: TOKEN,
        REDIRECT_FETCH: JSON.stringify({
          [new URL(PUBLIC_NETWORKS.preprod.rpc).origin]: s.rpc,
          [new URL(PUBLIC_NETWORKS.preprod.indexer).origin]: s.indexer,
        }),
      },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(s.queries.some((q) => q.includes(`project_id=${TOKEN}`))).toBe(true);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect((JSON.parse(text) as { network: { chainInstance: string } }).network.chainInstance).toBe(ONE);
    expect(text).not.toContain(TOKEN);
    expect(r.stdout).not.toContain(TOKEN);
  });

  it('a process that registered a token prints it neither to stdout nor to stderr', async () => {
    const script = join(tmp, 'print.mjs');
    writeFileSync(
      script,
      [
        `import { registerSecret } from ${JSON.stringify(join(repo, 'packages', 'midnight', 'src', 'redact.ts'))};`,
        `registerSecret(${JSON.stringify(TOKEN)});`,
        `process.stdout.write('out ${TOKEN}\\n');`,
        `process.stderr.write('err ${TOKEN}\\n');`,
      ].join('\n'),
    );
    const r = await run([script], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('out [redacted]\n');
    expect(r.stderr).toBe('err [redacted]\n');
  });
});
