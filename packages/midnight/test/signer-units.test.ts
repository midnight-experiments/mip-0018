// SPDX-License-Identifier: Apache-2.0
//
// Signer building blocks that need no chain: argument conversion, typed private state, run records, the
// "already present" before-check, the proof limiter/retry and the secret-file rules.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { commonRecords, encodePayload, record } from '@mip0018/codec';
import {
  ArgsError,
  circuitArgs,
  decodeTyped,
  encodeTyped,
  filePrivateStateProvider,
  fromJsonLoose,
  fromJsonTyped,
  limiter,
  loadRecord,
  masterSeed,
  readProtectedFile,
  saveRecord,
  seedFromHexFile,
  seedFromMnemonicFile,
  upsertStep,
  withRetry,
  wouldChange,
  type RunRecord,
} from '../src/signer/index.ts';
import { undeployedProfile, stagenetProfile } from '../src/network.ts';
import type { IndexedMiscEvent } from '../src/indexer.ts';

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mip0018-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const NAME = Buffer.from('mip-0018:token-metadata[v1]').toString('hex').padEnd(64, '0');
const CONTRACT = 'ab'.repeat(32);
const payload = (fields: Parameters<typeof commonRecords>[0], ds = '11', kind = 3) =>
  Buffer.from(encodePayload({ domainSep: Buffer.from(ds.repeat(32), 'hex'), kind }, commonRecords(fields))).toString('hex');
const ev = (id: number, height: number, p: string): IndexedMiscEvent => ({
  __typename: 'MiscContractEvent',
  id,
  contractAddress: CONTRACT,
  transactionId: id,
  raw: '',
  name: NAME,
  payload: p,
  transaction: { id, hash: id.toString(16).padStart(64, '0'), block: { height, hash: 'cc'.repeat(32) } },
});

describe('argument conversion', () => {
  const spikeManaged = join(import.meta.dirname, '..', '..', '..', 'test-contracts', 'toolchain-spike', 'managed', 'SpikeOzToken');
  const haveSpike = (() => {
    try {
      statSync(join(spikeManaged, 'compiler', 'contract-info.json'));
      return true;
    } catch {
      return false;
    }
  })();

  it('converts typed values and refuses wrong sizes/ranges', () => {
    expect(fromJsonTyped({ $utf8: 'ACME' }, { 'type-name': 'Bytes', length: 4 })).toEqual(new TextEncoder().encode('ACME'));
    expect(fromJsonTyped({ $utf8: 'AB' }, { 'type-name': 'Bytes', length: 4 })).toEqual(Uint8Array.from([0x41, 0x42, 0, 0]));
    expect(() => fromJsonTyped({ $utf8: 'ACMEX' }, { 'type-name': 'Bytes', length: 4 })).toThrow(ArgsError);
    expect(() => fromJsonTyped('0x0102', { 'type-name': 'Bytes', length: 3 })).toThrow(/needs 3 bytes/);
    expect(fromJsonTyped('18446744073709551615', { 'type-name': 'Uint', maxval: '18446744073709551615' })).toBe(18446744073709551615n);
    expect(() => fromJsonTyped('18446744073709551616', { 'type-name': 'Uint', maxval: '18446744073709551615' })).toThrow(/exceeds/);
    expect(
      fromJsonTyped(
        { bytes: '0x' + '01'.repeat(32) },
        { 'type-name': 'Struct', name: 'ZswapCoinPublicKey', elements: [{ name: 'bytes', type: { 'type-name': 'Bytes', length: 32 } }] },
      ),
    ).toEqual({
      bytes: Uint8Array.from(Buffer.from('01'.repeat(32), 'hex')),
    });
    expect(() =>
      fromJsonTyped(
        { bytes: '0x00', x: 1 },
        { 'type-name': 'Struct', name: 'S', elements: [{ name: 'bytes', type: { 'type-name': 'Bytes', length: 1 } }] },
      ),
    ).toThrow(/unknown field/);
  });

  it.runIf(haveSpike)('reads circuit argument types from contract-info.json (SpikeOzToken)', () => {
    const a = circuitArgs(spikeManaged, 'publishMetadata', [{ $utf8: 'Acme Token' }, { $utf8: 'ACME' }]);
    expect(a).toEqual([new TextEncoder().encode('Acme Token'), new TextEncoder().encode('ACME')]);
    expect(() => circuitArgs(spikeManaged, 'publishMetadata', [{ $utf8: 'Acme Token' }])).toThrow(/takes 2 argument/);
    const m = circuitArgs(spikeManaged, 'mint', [{ bytes: '0x' + '02'.repeat(32) }, 1000, '0x' + '03'.repeat(32)]);
    expect(m[1]).toBe(1000n);
  });

  it.runIf(haveSpike)('loads compiled contracts with and without witnesses (compact-js CompiledContract)', async () => {
    const { loadCompiledContract } = await import('../src/signer/providers.ts');
    const emitter = await loadCompiledContract({ name: 'SpikeEmitter', managedDir: join(spikeManaged, '..', 'SpikeEmitter') });
    expect(emitter).toBeTruthy();
    const oz = await loadCompiledContract(
      { name: 'SpikeOzToken', managedDir: spikeManaged },
      { wit_OwnableSK: (c: { privateState: unknown }) => [c.privateState, new Uint8Array(32)] },
    );
    expect(oz).toBeTruthy();
  });

  it('typed-JSON convention for constructor arguments', () => {
    expect(
      fromJsonLoose([
        '0x0a0b',
        6,
        'Acme',
        { $string: '0x12' },
        { $utf8: 'A', pad: 3 },
        { is_left: true, left: '0x01', right: { bytes: '0x02' } },
      ]),
    ).toEqual([
      Uint8Array.from([10, 11]),
      6n,
      'Acme',
      '0x12',
      Uint8Array.from([0x41, 0, 0]),
      { is_left: true, left: Uint8Array.from([1]), right: { bytes: Uint8Array.from([2]) } },
    ]);
    expect(() => fromJsonLoose(2 ** 60)).toThrow(/safe integer/);
  });
});

describe('private state and secrets', () => {
  it('round-trips bytes and bigints in a 0600 file', async () => {
    const d = tmp();
    const p = join(d, 'state', 'ps.json');
    const a = filePrivateStateProvider(p);
    await a.setSigningKey('aa', 'deadbeef' as never);
    await a.setFor('aa', 'Owner', { secretKey: Uint8Array.from([1, 2, 3]), n: 7n, m: new Map([['k', 1n]]) });
    expect((statSync(p).mode & 0o777).toString(8)).toBe('600');
    const b = filePrivateStateProvider(p);
    b.setContractAddress('aa');
    expect(await b.get('Owner')).toEqual({ secretKey: Uint8Array.from([1, 2, 3]), n: 7n, m: new Map([['k', 1n]]) });
    expect(await b.getSigningKey('aa')).toBe('deadbeef');
    expect(b.hasSigningKey('aa')).toBe(true);
    expect(decodeTyped(encodeTyped({ x: [1n, Uint8Array.from([255])] }))).toEqual({ x: [1n, Uint8Array.from([255])] });
  });

  it('refuses group/other-readable secret files and never echoes their content', () => {
    const d = tmp();
    const f = join(d, 'w.mnemonic');
    const phrase = generateMnemonic(wordlist, 256); // a fresh random test phrase, never a real wallet
    writeFileSync(f, phrase);
    chmodSync(f, 0o644);
    expect(() => readProtectedFile(f)).toThrow(/chmod 600/);
    chmodSync(f, 0o600);
    expect(seedFromMnemonicFile(f)).toHaveLength(64);
    writeFileSync(f, 'not a valid phrase at all but twelve words long ok yes no');
    try {
      seedFromMnemonicFile(f);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/valid phrase/);
    }
    const h = join(d, 'seed.hex');
    writeFileSync(h, '00'.repeat(32), { mode: 0o600 });
    expect(seedFromHexFile(h)).toHaveLength(32);
  });

  it('hex seeds and the dev genesis wallet are refused outside undeployed', () => {
    const local = undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: 'http://node:9944' });
    expect(masterSeed({ devGenesis: true }, local)[31]).toBe(1);
    expect(() => masterSeed({ devGenesis: true }, stagenetProfile())).toThrow(/undeployed/);
    expect(() => masterSeed({}, local)).toThrow(/exactly one/);
  });
});

describe('records', () => {
  it('atomic save/load; steps are idempotent by id; no secret fields', () => {
    const d = tmp();
    const p = join(d, 'run.json');
    const r: RunRecord = {
      kind: 'mip0018-run-record',
      schema: 1,
      createdAt: '',
      updatedAt: '',
      network: { id: 'undeployed', networkId: 'undeployed', genesisHash: '0x' + '00'.repeat(32), indexer: 'i', rpc: 'r' },
      contract: { name: 'X', managedDir: 'm', verifierKeySha256: { a: 'b' } },
      steps: [],
    };
    const s1 = upsertStep(r, { id: 'deploy', kind: 'deploy' });
    const s2 = upsertStep(r, { id: 'deploy', kind: 'deploy' });
    expect(s1).toBe(s2);
    s1.tx = { hash: 'aa', identifiers: ['bb'], ttl: new Date(0).toISOString() };
    saveRecord(p, r);
    expect(loadRecord(p)!.steps[0]!.tx!.hash).toBe('aa');
    expect(readFileSync(p, 'utf8')).not.toMatch(/signingKey|secret|mnemonic|seed/iu);
  });
});

describe('before-check: would this publish change the metadata?', () => {
  const p1 = payload({ name: 'Acme Token', symbol: 'ACME', decimals: 6 });
  const p2 = payload({ name: 'Acme Token 2', symbol: 'ACME', decimals: 6 });
  it('no change when the same values are already current; a change otherwise', () => {
    expect(wouldChange('n', CONTRACT, [], [{ name: NAME, payload: p1 }])).toBe(true);
    expect(wouldChange('n', CONTRACT, [ev(1, 10, p1)], [{ name: NAME, payload: p1 }])).toBe(false);
    expect(wouldChange('n', CONTRACT, [ev(1, 10, p1)], [{ name: NAME, payload: p2 }])).toBe(true);
    // rename A → B → A: the third publish changes the state again
    expect(wouldChange('n', CONTRACT, [ev(1, 10, p1), ev(2, 11, p2)], [{ name: NAME, payload: p1 }])).toBe(true);
    // a tombstone after a tombstone changes nothing
    const tomb = Buffer.from(encodePayload({ domainSep: Buffer.from('11'.repeat(32), 'hex'), kind: 3 }, [record.tombstone()])).toString(
      'hex',
    );
    expect(wouldChange('n', CONTRACT, [ev(1, 10, p1)], [{ name: NAME, payload: tomb }])).toBe(true);
    expect(wouldChange('n', CONTRACT, [ev(1, 10, p1), ev(2, 11, tomb)], [{ name: NAME, payload: tomb }])).toBe(false);
  });
  it('does not apply to events that are not accepted (negative cases are never skipped)', () => {
    const bad = '11'.repeat(32) + '09' + '00'.repeat(223); // kind 9 → reject
    expect(wouldChange('n', CONTRACT, [], [{ name: NAME, payload: bad }])).toBeUndefined();
    expect(wouldChange('n', CONTRACT, [], [{ name: '00'.repeat(32), payload: p1 }])).toBeUndefined();
    expect(wouldChange('n', CONTRACT, [], [])).toBeUndefined();
  });
});

describe('proof provider plumbing', () => {
  it('limiter runs at most n tasks at once', async () => {
    const limit = limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 7 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
  it('withRetry retries 408/429/502/504 and connection drops only', async () => {
    let n = 0;
    await expect(
      withRetry(
        'x',
        async () => (++n < 3 ? Promise.reject(new Error('code="429"')) : 'ok'),
        4,
        async () => {},
      ),
    ).resolves.toBe('ok');
    expect(n).toBe(3);
    n = 0;
    await expect(
      withRetry(
        'x',
        async () => (++n, Promise.reject(new Error('code="400"'))),
        4,
        async () => {},
      ),
    ).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});
