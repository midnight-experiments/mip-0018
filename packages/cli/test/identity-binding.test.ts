// SPDX-License-Identifier: Apache-2.0
//
// Every command that acts on a recorded file checks the chain the file recorded before its first read or
// transaction: the genesis and the chain instance (block 1) of a run record, of a scanner state and of the network
// file of the case folder the file lies in. Against a local node stub with the recorded genesis but ANOTHER block 1 (a
// network re-created from the same genesis), each command is refused and the indexer is never queried; a conflicting
// --chain-instance is refused before any request. Signer commands are refused before a wallet is opened.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBlock, newState, PUBLIC_NETWORKS, saveState, tokenTypeHex, undeployedProfile, type ScannedBlock } from '@mip0018/midnight';
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
const C3 = h32('c3');

// A scanner state built from mint transactions recorded on a local chain (its genesis is the local chain's).
const fixtures = join(import.meta.dirname, '..', '..', 'midnight', 'test', 'fixtures', 'local');
const fx = JSON.parse(readFileSync(join(fixtures, 'mint-txs.json'), 'utf8')) as {
  contractAddress: string;
  transactions: { hash: string; height: number; blockHash: string; raw: string; transactionResult: never }[];
  expected: { color: string; domainSep: string };
};
const G = (JSON.parse(readFileSync(join(fixtures, 'meta.json'), 'utf8')) as { genesisHash: string }).genesisHash;
const CONTRACT = fx.contractAddress;
const TX = 'ab'.repeat(32);

const tmp = mkdtempSync(join(tmpdir(), 'mip0018-identity-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A run record of `network` (undeployed with genesis G by default) with one published call. */
function writeRecord(path: string, network: Record<string, string> = { id: 'undeployed', genesisHash: G, chainInstance: C1 }): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      kind: 'mip0018-run-record',
      schema: 1,
      network: { networkId: network.id, indexer: 'http://indexer', rpc: 'http://node', ...network },
      contract: { name: 'X', managedDir: 'm', verifierKeySha256: {}, address: CONTRACT },
      steps: [
        { id: 'deploy', kind: 'deploy', state: 'completed', tx: { hash: TX, identifiers: [] }, attempts: [] },
        {
          id: 'publish',
          kind: 'call',
          circuit: 'publishMetadata',
          state: 'completed',
          tx: { hash: TX, identifiers: [] },
          expectedEvents: [{ name: '00', payload: '00' }],
          inclusion: { height: 5, hash: 'cc'.repeat(32), status: 'SUCCESS' },
          attempts: [],
        },
      ],
    }),
  );
  return path;
}

let stub: ChainStub;
beforeEach(async () => {
  stub = await chainStub({ genesis: G, blockOne: C2 });
});
afterEach(async () => {
  await stub.close();
});
const undeployed = () => ['--network', 'undeployed', '--rpc', stub.rpc, '--indexer', stub.indexer];

describe('record-based wallet-free commands check the recorded chain instance before any indexer read', () => {
  it('list --record: same genesis, another block 1 → refused, no indexer request', async () => {
    const rec = writeRecord(join(tmp, 'list', 'record.json'));
    const r = await run(['list', ...undeployed(), '--record', rec]);
    expect(r.stderr).toMatch(/another instance of undeployed: node block 1 is 0xc2c2.*expected 0xc1c1/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer).toBe(0);
  });

  it('check-event --record: same genesis, another block 1 → refused, no indexer request', async () => {
    const rec = writeRecord(join(tmp, 'check-event', 'record.json'));
    const r = await run(['check-event', ...undeployed(), '--record', rec, '--step', 'publish']);
    expect(r.stderr).toMatch(/another instance of undeployed/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer).toBe(0);
  });

  it('a record of another genesis, or a --chain-instance that contradicts the record, is refused before any request', async () => {
    const rec = writeRecord(join(tmp, 'conflict', 'record.json'));
    const r = await run(['list', ...undeployed(), '--record', rec, '--chain-instance', C3]);
    expect(r.stderr).toMatch(/records chain instance \(block 1\) 0xc1c1.*--chain-instance.*0xc3c3/u);
    expect(r.status).toBe(2);
    const other = writeRecord(join(tmp, 'conflict2', 'record.json'), { id: 'undeployed', genesisHash: h32('99'), chainInstance: C1 });
    const g = await run(['list', ...undeployed(), '--record', other, '--genesis', G]);
    expect(g.stderr).toMatch(/records genesis 0x9999/u);
    expect(g.status).toBe(2);
    expect(stub.counts.rpc + stub.counts.indexer).toBe(0);
  });

  it('lookup --record (live): the state and the record name block 1; another block 1 → refused, no indexer request', async () => {
    const profile = undeployedProfile({ indexer: 'http://indexer', rpc: 'http://node', genesisHash: G });
    const FROM = Math.min(...fx.transactions.map((t) => t.height));
    const TO = Math.max(...fx.transactions.map((t) => t.height));
    const state = newState(profile, G, FROM, C1);
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
                contractActions: [{ __typename: 'ContractCall', address: CONTRACT }],
                transactionResult: t.transactionResult,
              },
            ]
          : [],
      };
      applyBlock(state, b);
    }
    const stateDir = join(tmp, 'lookup', 'index');
    saveState(stateDir, state);
    expect(tokenTypeHex(fx.expected.domainSep, CONTRACT)).toBe(fx.expected.color);
    const rec = writeRecord(join(tmp, 'lookup', 'record.json'));
    const r = await run(['lookup', ...undeployed(), '--record', rec, '--domain-sep', fx.expected.domainSep, '--state', stateDir]);
    expect(r.stderr).toMatch(/another instance of undeployed/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer).toBe(0);
  });

  it('index: a state inside a case folder takes the network file; another block 1 → refused, no indexer request', async () => {
    const net = join(tmp, 'index-net');
    mkdirSync(join(net, 'cases', 'IDX'), { recursive: true });
    writeFileSync(join(net, 'network.json'), JSON.stringify({ network: { id: 'undeployed', genesisHash: G, chainInstance: C1 } }));
    const r = await run([
      'index',
      ...undeployed(),
      '--state',
      join(net, 'cases', 'IDX', 'index'),
      '--from-height',
      '1',
      '--to-height',
      '3',
      '--poll',
    ]);
    expect(r.stderr).toMatch(/another instance of undeployed/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer).toBe(0);
  });
});

describe('recheck ends a case on the wrong chain before any further read', () => {
  const caseFiles = (dir: string, network?: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    writeRecord(join(dir, 'record.json'), network);
    writeFileSync(join(dir, 'expected.json'), JSON.stringify({ identities: [], groups: [] }));
    writeFileSync(
      join(dir, 'case.json'),
      JSON.stringify({
        id: 'T',
        recheck: {
          checkEvent: [{ record: 'record.json', step: 'publish' }],
          list: [{ record: 'record.json', expect: 'expected.json' }],
          operationsAbsent: [{ record: 'record.json', circuit: 'publishMetadata' }],
        },
      }),
    );
  };

  it('the run record names block 1: another block 1 → one failed identity result, no indexer request', async () => {
    const dir = join(tmp, 'recheck-undeployed');
    caseFiles(dir);
    const r = await run(['recheck', ...undeployed(), '--case', dir, '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout) as { ok: boolean; results: { id: string; ok: boolean; message: string }[] };
    expect(j.ok).toBe(false);
    expect(j.results).toHaveLength(1);
    expect(j.results[0]).toMatchObject({ id: 'identity', ok: false });
    expect(j.results[0]!.message).toMatch(/another instance of undeployed/u);
    expect(stub.counts.indexer).toBe(0);
  });

  it("the case folder's network file names block 1 (a public network behind a mirror): no contract-operations query", async () => {
    const net = join(tmp, 'preview');
    const dir = join(net, 'cases', 'T');
    caseFiles(dir, { id: 'preview', genesisHash: PUBLIC_NETWORKS.preview.genesisHash, chainInstance: C1 });
    writeFileSync(
      join(net, 'network.json'),
      JSON.stringify({ network: { id: 'preview', genesisHash: PUBLIC_NETWORKS.preview.genesisHash, chainInstance: C1 } }),
    );
    await stub.close();
    stub = await chainStub({ genesis: PUBLIC_NETWORKS.preview.genesisHash, blockOne: C2 });
    const r = await run(['recheck', '--network', 'preview', '--rpc', stub.rpc, '--indexer', stub.indexer, '--case', dir, '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout) as { results: { id: string; ok: boolean; message: string }[] };
    expect(j.results.map((x) => x.id)).toEqual(['identity']);
    expect(j.results[0]!.message).toMatch(/another instance of preview/u);
    expect(stub.counts.indexer).toBe(0);
  });
});

describe('signer commands check the recorded chain instance before a wallet is opened', () => {
  const managed = join(tmp, 'managed', 'Fake');
  mkdirSync(join(managed, 'contract'), { recursive: true });
  mkdirSync(join(managed, 'keys'), { recursive: true });
  writeFileSync(join(managed, 'contract', 'index.js'), 'export {};\n');
  const signer = (cmd: string[], record: string) => [
    ...cmd,
    ...undeployed(),
    '--record',
    record,
    '--contract',
    managed,
    '--proof-server',
    'http://127.0.0.1:9',
    '--state-dir',
    join(tmp, 'signer-state'),
    '--dev-genesis-wallet',
  ];

  it('publish on an existing record: another block 1 → refused before the wallet opens', async () => {
    const rec = writeRecord(join(tmp, 'signer-existing', 'record.json'));
    const r = await run(signer(['publish', '--circuit', 'publishMetadata'], rec), 20_000);
    expect(r.stderr).toMatch(/another instance of undeployed/u);
    expect(r.stderr).not.toMatch(/opening the wallet/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer + stub.counts.upgrades).toBe(0);
  });

  it('deploy into a case folder: its network file names block 1; another block 1 → refused before the wallet opens', async () => {
    const net = join(tmp, 'signer-net');
    mkdirSync(join(net, 'cases', 'C01'), { recursive: true });
    writeFileSync(join(net, 'network.json'), JSON.stringify({ network: { id: 'undeployed', genesisHash: G, chainInstance: C1 } }));
    const r = await run(signer(['deploy'], join(net, 'cases', 'C01', 'record.json')), 20_000);
    expect(r.stderr).toMatch(/another instance of undeployed/u);
    expect(r.stderr).not.toMatch(/opening the wallet/u);
    expect(r.status).toBe(1);
    expect(stub.counts.indexer + stub.counts.upgrades).toBe(0);
  });
});
