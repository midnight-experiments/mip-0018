// SPDX-License-Identifier: Apache-2.0
//
// Every identity source a command is given is used or refused, and all of them are collected before any early exit:
// `lookup` refuses option combinations it would otherwise ignore, checks the state, the run record and their case
// folders' network files before reporting a color as not minted, and reads a state that records no chain instance only
// on a node that has the state's last scanned block; `index` refuses a state of another chain with a usage error; a
// signer command started with `--attach @<record>` binds the network file of that record's case folder; `recheck`
// binds the scanner states a case names. Against a local node + indexer stub that counts every request.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBlock, newState, saveState, undeployedProfile, type ScannedBlock } from '@mip0018/midnight';
import { chainStub, type ChainStub } from '../../midnight/test/support/chain-stub.ts';

const bin = join(import.meta.dirname, '..', 'bin', 'mip0018.js');

/** Runs the CLI without blocking the event loop (the stub runs in this process); killed after `timeoutMs`. */
function run(args: string[], timeoutMs = 30_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('MIP0018_')) delete env[k];
    const p = spawn(process.execPath, [bin, ...args], { env });
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

const h32 = (b: string) => `0x${b.repeat(32)}`;
const C1 = h32('c1');
const C2 = h32('c2');
const G2 = h32('77');

const fixtures = join(import.meta.dirname, '..', '..', 'midnight', 'test', 'fixtures', 'local');
const fx = JSON.parse(readFileSync(join(fixtures, 'mint-txs.json'), 'utf8')) as {
  contractAddress: string;
  transactions: { hash: string; height: number; blockHash: string; raw: string; transactionResult: never }[];
  expected: { color: string; domainSep: string };
};
const G = (JSON.parse(readFileSync(join(fixtures, 'meta.json'), 'utf8')) as { genesisHash: string }).genesisHash;
const CONTRACT = fx.contractAddress;
const TX = 'ab'.repeat(32);
const FROM = Math.min(...fx.transactions.map((t) => t.height));
const TO = Math.max(...fx.transactions.map((t) => t.height));

const tmp = mkdtempSync(join(tmpdir(), 'mip0018-identity-sources-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A run record of the local chain (genesis G) with one published call. */
function writeRecord(path: string, network: Record<string, string> = { id: 'undeployed', genesisHash: G, chainInstance: C1 }): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      kind: 'mip0018-run-record',
      schema: 1,
      network: { networkId: network.id, indexer: 'http://indexer', rpc: 'http://node', ...network },
      contract: { name: 'X', managedDir: 'm', verifierKeySha256: {}, address: CONTRACT },
      steps: [{ id: 'deploy', kind: 'deploy', state: 'completed', tx: { hash: TX, identifiers: [] }, attempts: [] }],
    }),
  );
  return path;
}

/**
 * A scanner state with the fixture's mints (its color is in the table), ending with an empty block whose hash is
 * `lastHash`; with `chainInstance`, the state records it.
 */
function writeState(dir: string, lastHash: string, chainInstance?: string): string {
  const profile = undeployedProfile({ indexer: 'http://indexer', rpc: 'http://node', genesisHash: G });
  const state = newState(profile, G, FROM, chainInstance);
  const block = (h: number, hash: string, txs: ScannedBlock['transactions']): ScannedBlock => ({
    height: h,
    hash,
    timestamp: 0,
    parent: null,
    transactions: txs,
  });
  for (let h = FROM; h <= TO; h++) {
    const t = fx.transactions.find((x) => x.height === h);
    applyBlock(
      state,
      block(
        h,
        (t?.blockHash ?? h.toString(16)).padStart(64, '0'),
        t
          ? [
              {
                __typename: 'RegularTransaction',
                id: h,
                hash: t.hash,
                raw: t.raw,
                contractActions: [{ __typename: 'ContractCall', address: CONTRACT }],
                transactionResult: t.transactionResult,
              },
            ]
          : [],
      ),
    );
  }
  applyBlock(state, block(TO + 1, lastHash, []));
  saveState(dir, state);
  return dir;
}
/** The stub's hash of block `h` (no 0x). */
const stubHash = (h: number) => h.toString(16).padStart(64, '0');

let stub: ChainStub;
beforeEach(async () => {
  stub = await chainStub({ genesis: G, blockOne: C2 });
});
afterEach(async () => {
  await stub.close();
});
const undeployed = () => ['--network', 'undeployed', '--rpc', stub.rpc, '--indexer', stub.indexer];

describe('lookup: every option given is used or refused, every identity source checked first', () => {
  it('--record without --domain-sep (with --color) is refused, not ignored', async () => {
    const state = writeState(join(tmp, 'l1', 'index'), stubHash(TO + 1), C1);
    const rec = writeRecord(join(tmp, 'l1', 'record.json'));
    const r = await run(['lookup', '--color', fx.expected.color, '--record', rec, '--state', state]);
    expect(r.stderr).toMatch(/--color excludes --contract, --record and --domain-sep/u);
    expect(r.status).toBe(2);
  });

  it('--contract and --record together are refused', async () => {
    const state = writeState(join(tmp, 'l2', 'index'), stubHash(TO + 1), C1);
    const rec = writeRecord(join(tmp, 'l2', 'record.json'));
    const r = await run(['lookup', '--contract', CONTRACT, '--record', rec, '--domain-sep', fx.expected.domainSep, '--state', state]);
    expect(r.stderr).toMatch(/--contract and --record exclude each other/u);
    expect(r.status).toBe(2);
  });

  it('a network option without --network is refused', async () => {
    const state = writeState(join(tmp, 'l3', 'index'), stubHash(TO + 1), C2);
    const r = await run(['lookup', '--color', fx.expected.color, '--chain-instance', C1, '--state', state]);
    expect(r.stderr).toMatch(/--chain-instance: network options need --network/u);
    expect(r.status).toBe(2);
  });

  it('a color not in the table is reported only after the identity sources agree: a contradicting --genesis exits 2 first', async () => {
    const state = writeState(join(tmp, 'l4', 'index'), stubHash(TO + 1), C2);
    const r = await run(['lookup', ...undeployed(), '--genesis', G2, '--color', 'ee'.repeat(32), '--state', state]);
    expect(r.stderr).toMatch(/records genesis .*but the undeployed profile \(--genesis\) has 0x7777/u);
    expect(r.status).toBe(2);
    expect(stub.counts.rpc + stub.counts.indexer).toBe(0);
  });

  it("live, a state without a chain instance outside a case folder: another chain at the state's last block → refused, no indexer request", async () => {
    const state = writeState(join(tmp, 'l5', 'index'), 'ee'.repeat(32));
    const r = await run(['lookup', ...undeployed(), '--color', fx.expected.color, '--state', state]);
    expect(r.stderr).toMatch(/records no chain instance and its last scanned block \d+ is eeee.*another chain/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer).toBe(0);
  });

  it("live, a state without a chain instance on a node that has the state's last block: the metadata is read", async () => {
    const state = writeState(join(tmp, 'l6', 'index'), stubHash(TO + 1));
    const r = await run(['lookup', ...undeployed(), '--color', fx.expected.color, '--state', state, '--json']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(stub.counts.indexer).toBeGreaterThan(0);
  });
});

describe('index and recheck bind every file they read', () => {
  it('index: a state that records another genesis is a usage error, before any request', async () => {
    const state = writeState(join(tmp, 'i1', 'index'), stubHash(TO + 1), C2);
    const r = await run(['index', ...undeployed(), '--genesis', G2, '--state', state, '--from-height', String(FROM), '--poll']);
    expect(r.stderr).toMatch(/records genesis/u);
    expect(r.status).toBe(2);
    expect(stub.counts.rpc + stub.counts.indexer).toBe(0);
  });

  it('recheck: the scanner state a case names records block 1; another block 1 → one failed identity result, no indexer request', async () => {
    const dir = join(tmp, 'r1');
    writeRecord(join(dir, 'record.json'), { id: 'undeployed', genesisHash: G });
    writeState(join(dir, 'index'), stubHash(TO + 1), C1);
    writeFileSync(
      join(dir, 'case.json'),
      JSON.stringify({
        id: 'T',
        recheck: { colors: [{ record: 'record.json', domainSep: fx.expected.domainSep, kind: 1, index: 'index' }] },
      }),
    );
    const r = await run(['recheck', ...undeployed(), '--case', dir, '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout) as { results: { id: string; ok: boolean; message: string }[] };
    expect(j.results.map((x) => x.id)).toEqual(['identity']);
    expect(j.results[0]!.message).toMatch(/another instance of undeployed/u);
    expect(stub.counts.indexer).toBe(0);
  });
});

describe('signer --attach @<record> binds the network file of the case folder of that record', () => {
  const managed = join(tmp, 'managed', 'Fake');
  mkdirSync(join(managed, 'contract'), { recursive: true });
  mkdirSync(join(managed, 'keys'), { recursive: true });
  writeFileSync(join(managed, 'contract', 'index.js'), 'export {};\n');

  it('the attached record lies in a case folder whose network file names block 1; another block 1 → refused before the wallet opens', async () => {
    const net = join(tmp, 'attach-net');
    const attached = writeRecord(join(net, 'cases', 'C01', 'record.json'), { id: 'undeployed', genesisHash: G });
    writeFileSync(join(net, 'network.json'), JSON.stringify({ network: { id: 'undeployed', genesisHash: G, chainInstance: C1 } }));
    const r = await run(
      [
        'publish',
        ...undeployed(),
        '--record',
        join(tmp, 'attach-new', 'record.json'),
        '--attach',
        `@${attached}`,
        '--contract',
        managed,
        '--circuit',
        'publishMetadata',
        '--proof-server',
        'http://127.0.0.1:9',
        '--state-dir',
        join(tmp, 'signer-state'),
        '--dev-genesis-wallet',
      ],
      20_000,
    );
    expect(r.stderr).toMatch(/another instance of undeployed/u);
    expect(r.stderr).not.toMatch(/opening the wallet/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer + stub.counts.upgrades).toBe(0);
  });
});
