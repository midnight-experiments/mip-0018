// SPDX-License-Identifier: Apache-2.0
//
// The plain midnight-js snippet starts its wallet through `openWallet`, so it refuses a node with a public network's
// genesis for the undeployed profile before the wallet connects, and reports it as one line (exit 1). Against a local
// node + indexer stub that counts every request and WebSocket upgrade.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_NETWORKS } from '@mip0018/midnight';
import { chainStub, type ChainStub } from '../../../packages/midnight/test/support/chain-stub.ts';

const repo = join(import.meta.dirname, '..', '..', '..');
const stubs: ChainStub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});

/** Runs the snippet without blocking this event loop (the stub runs here); killed after `timeoutMs`. */
function run(env: Record<string, string>, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(clean)) if (k.startsWith('MIP0018_')) delete clean[k];
    const p = spawn(process.execPath, [join(repo, 'examples', 'publish-and-emit', 'scripts', 'midnight-js-snippet.ts')], {
      env: { ...clean, ...env },
      cwd: repo,
    });
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

describe('midnight-js snippet', () => {
  it('undeployed at a node with a public genesis: refused before the wallet connects', async () => {
    const s = await chainStub({ genesis: PUBLIC_NETWORKS.preview.genesisHash, blockOne: `0x${'c1'.repeat(32)}` });
    stubs.push(s);
    const r = await run(
      { MIP0018_NODE_URL: s.rpc, MIP0018_INDEXER_URL: s.indexer, MIP0018_PROOF_SERVER_URL: 'http://127.0.0.1:9' },
      20_000,
    );
    expect(r.stderr).toMatch(/^midnight-js-snippet: IdentityError: the undeployed profile points at a node with the preview genesis/mu);
    expect(r.status).toBe(1);
    expect(s.counts.indexer + s.counts.upgrades).toBe(0);
  });
});
