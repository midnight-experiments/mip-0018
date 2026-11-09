// SPDX-License-Identifier: Apache-2.0
//
// CLI behaviour that needs no chain: usage errors and exit codes, lookup against a scanner state, vectors run.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyBlock, newState, saveState, undeployedProfile, type ScannedBlock } from '@mip0018/midnight';
import { readFileSync } from 'node:fs';

const bin = join(import.meta.dirname, '..', 'bin', 'mip0018.js');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, MIP0018_INDEXER_URL: '', MIP0018_NODE_URL: '' },
  });

const dir = mkdtempSync(join(tmpdir(), 'mip0018-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A scanner state built from the mint transactions recorded on a local chain (no network).
const fixtures = join(import.meta.dirname, '..', '..', 'midnight', 'test', 'fixtures', 'local');
const fx = JSON.parse(readFileSync(join(fixtures, 'mint-txs.json'), 'utf8')) as {
  contractAddress: string;
  transactions: { hash: string; height: number; blockHash: string; raw: string; transactionResult: never }[];
  expected: { color: string; domainSep: string };
};
const meta = JSON.parse(readFileSync(join(fixtures, 'meta.json'), 'utf8')) as { indexer: string; rpc: string; genesisHash: string };
const profile = undeployedProfile({ indexer: meta.indexer, rpc: meta.rpc, genesisHash: meta.genesisHash });
const FROM = Math.min(...fx.transactions.map((t) => t.height));
const TO = Math.max(...fx.transactions.map((t) => t.height));
const state = newState(profile, profile.genesisHash!, FROM);
for (let h = FROM; h <= TO; h++) {
  const t = fx.transactions.find((x) => x.height === h);
  const b: ScannedBlock = {
    height: h,
    hash: (t?.blockHash ?? h.toString(16)).padStart(64, '0'),
    timestamp: 0,
    parent: null,
    transactions: t
      ? [
          {
            __typename: 'RegularTransaction',
            id: h,
            hash: t.hash,
            raw: t.raw,
            contractActions: [{ __typename: 'ContractCall', address: fx.contractAddress }],
            transactionResult: t.transactionResult,
          },
        ]
      : [],
  };
  applyBlock(state, b);
}
saveState(dir, state);

describe('mip0018 CLI', () => {
  it('prints usage and exits 2 without a command; 0 with --help', () => {
    expect(run([]).status).toBe(2);
    expect(run(['--help']).status).toBe(0);
    expect(run(['check-event', '--help']).stdout).toMatch(/Exit: 0 ok · 1 mismatch/);
  });

  it('usage errors exit 2 (missing flags, unknown option, unknown network, missing token, undeployed without URLs)', () => {
    expect(run(['check-event', '--network', 'preview']).status).toBe(2);
    expect(run(['check-event', '--network', 'preview', '--bogus', 'x']).status).toBe(2);
    const unknown = run(['list', '--network', 'testnet-02', '--contract', 'ab'.repeat(32)]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/unknown network "testnet-02" \(expected one of: undeployed, preview, preprod, mainnet\)/);
    const noToken = run(['list', '--network', 'mainnet', '--contract', 'ab'.repeat(32)], { MIP0018_BLOCKFROST_MAINNET: '' });
    expect(noToken.status).toBe(2);
    expect(noToken.stderr).toMatch(/MIP0018_BLOCKFROST_MAINNET/);
    const r = run(['list', '--network', 'undeployed', '--contract', 'ab'.repeat(32)]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/indexer URL is required/);
    expect(run(['bogus']).status).toBe(2);
  });

  it('lookup resolves a minted color, reports the scanned range otherwise, and refuses kind 3', () => {
    const ok = run(['lookup', '--color', fx.expected.color, '--state', dir, '--json']);
    expect(ok.status).toBe(0);
    const j = JSON.parse(ok.stdout) as { identities: { kind: number; contractAddress: string; domainSep: string }[] };
    expect(j.identities.map((i) => i.kind)).toEqual([1, 2]);
    expect(j.identities[0]).toMatchObject({ contractAddress: fx.contractAddress, domainSep: fx.expected.domainSep });
    const only2 = JSON.parse(run(['lookup', '--color', fx.expected.color, '--state', dir, '--kind', '2', '--json']).stdout) as {
      identities: { kind: number }[];
    };
    expect(only2.identities.map((i) => i.kind)).toEqual([2]);
    const miss = run(['lookup', '--color', 'ab'.repeat(32), '--state', dir]);
    expect(miss.status).toBe(3);
    expect(miss.stdout).toContain(`not minted in the scanned range [${FROM}, ${TO}]`);
    const k3 = run(['lookup', '--color', fx.expected.color, '--state', dir, '--kind', '3']);
    expect(k3.status).toBe(2);
    expect(k3.stderr).toMatch(/kind 3 \(contract token\) has no color/);
  });

  it('signer commands refuse to run without a proof server or a state dir (nothing opened)', () => {
    const r = run(['wallet', 'status', '--network', 'preview']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/proof-server/);
  });

  it('vectors run passes every normative vector with the reference consumer', () => {
    const r = run(['vectors', 'run', '--normative-only']);
    expect(r.status).toBe(0);
  }, 120_000);
});
