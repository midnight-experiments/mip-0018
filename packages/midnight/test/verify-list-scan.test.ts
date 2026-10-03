// SPDX-License-Identifier: Apache-2.0
//
// verify / list / scan against recorded Stagenet exchanges (the S0-SPIKE case), plus synthetic edge cases.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.ts';
import { stagenetProfile } from '../src/network.ts';
import { verifyEmission, type VerifyReport } from '../src/verify.ts';
import { listMetadata, reduceScannedEvents } from '../src/list.ts';
import { commonRecords, encodePayload, EVENT_NAME, withdrawRecords } from '@mip0018/codec';
import { applyBlock, loadState, lookupColor, newState, scan, ScanError, type ScanState } from '../src/scanner.ts';
import type { ScannedBlock } from '../src/indexer.ts';
import { toJson } from '../src/hex.ts';
import { loadTape, replayFetch } from './support/cassette.ts';

const dir = join(import.meta.dirname, 'fixtures', 'stagenet');
const profile = stagenetProfile();
const SPIKE = '18097aeb608f35d83a65b2cad987084c97c6e9d1dc02973f2a6f6cc2fcdd76e1';
const PUBLISH = '223050717f704fe47d1bd0b6b91da8ea248139d2d15a23a2eab7cf07d5a51418';
const DEPLOY = '62bd33fd5fe18ca2ddd78922f4685eabac97f4de2418492daf753568cee8b059';
const A1_META = { domainSep: '11'.repeat(32), kind: 3, name: 'Acme Token', symbol: 'ACME', decimals: 6, standards: ['mip-0004'] };

const replay = (name: string) => new HttpClient({ fetch: replayFetch(loadTape(join(dir, `${name}.tape.json`))), attempts: 1 });
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe('verify (recorded Stagenet)', () => {
  it('S0-SPIKE publish: every check passes, the event is A1 and accepted', async () => {
    const r = await verifyEmission({
      profile,
      contract: SPIKE,
      tx: PUBLISH,
      http: replay('verify-spike-publish'),
      expect: { metadata: A1_META },
    });
    expect(r.outcome).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      contractAddress: SPIKE,
      inRawTransaction: true,
      segmentApplied: true,
      classification: { result: 'accept', kind: 3 },
    });
    expect(r.inclusion).toMatchObject({ height: 710810, finalized: true, extrinsicIndex: 3 });
    const recorded = JSON.parse(readFileSync(join(dir, 'verify-spike-publish.result.json'), 'utf8')) as VerifyReport;
    expect(r.events[0]!.payload).toBe(recorded.events[0]!.payload);
  });

  it('a wrong expectation is a mismatch (exit 1)', async () => {
    const r = await verifyEmission({
      profile,
      contract: SPIKE,
      tx: PUBLISH,
      http: replay('verify-spike-publish'),
      expect: { metadata: { ...A1_META, name: 'Other Token' } },
    });
    expect(r.outcome).toBe('mismatch');
    expect(r.exitCode).toBe(1);
    expect(r.events[0]!.expectation!.ok).toBe(false);
    const r2 = await verifyEmission({
      profile,
      contract: SPIKE,
      tx: PUBLISH,
      http: replay('verify-spike-publish'),
      expect: { result: 'reject' },
    });
    expect(r2.exitCode).toBe(1);
  });

  it('the deploy transaction holds no event: not-found (exit 3)', async () => {
    const r = await verifyEmission({ profile, contract: SPIKE, tx: DEPLOY, http: replay('verify-spike-deploy') });
    expect(r.outcome).toBe('not-found');
    expect(r.exitCode).toBe(3);
  });

  it('an unknown transaction: not-found when the indexer is caught up, not-indexed when it lags', async () => {
    const unknown = 'ee'.repeat(32);
    const mk = (finalized: number, tip: number) => {
      const f = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[]; query?: string };
        const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
        if (body.method === 'chain_getBlockHash') {
          const h = (body.params as number[])[0];
          return ok(h === 0 ? profile.genesisHash : '0x' + h!.toString(16).padStart(64, '0'));
        }
        if (body.method === 'chain_getFinalizedHead') return ok('0x' + 'f1'.repeat(32));
        if (body.method === 'chain_getHeader') return ok({ number: '0x' + finalized.toString(16), parentHash: '0x' + '00'.repeat(32) });
        if (body.method === 'chain_getBlock') return ok({ block: { extrinsics: ['0x00'] } });
        return new Response(
          JSON.stringify({ data: { block: { height: tip, hash: 'aa'.repeat(32), timestamp: 0 }, contractEvents: [], transactions: [] } }),
          { status: 200 },
        );
      }) as typeof fetch;
      return new HttpClient({ fetch: f, attempts: 1 });
    };
    expect((await verifyEmission({ profile, contract: SPIKE, tx: unknown, http: mk(100, 100) })).outcome).toBe('not-found');
    expect((await verifyEmission({ profile, contract: SPIKE, tx: unknown, http: mk(200, 100) })).outcome).toBe('not-indexed');
  });
});

describe('list (recorded Stagenet)', () => {
  it('S0-SPIKE: one kind-3 identity with the A1 fields, no color, one group', async () => {
    const r = await listMetadata({ profile, contract: SPIKE, toBlock: 710820, http: replay('list-spike') });
    expect(r.snapshot.toBlock).toBe(710820);
    expect(r.snapshot.tipMatchesNode).toBe(true);
    expect(r.counts).toEqual({ events: 1, accepted: 1, rejected: 0, ignored: 0 });
    expect(r.identities).toHaveLength(1);
    const id = r.identities[0]!;
    expect(id).toMatchObject({ contractAddress: SPIKE, domainSep: '11'.repeat(32), kind: 3, colored: false, color: null });
    expect(id).not.toHaveProperty('visible');
    expect(id.common).toEqual({ name: 'Acme Token', symbol: 'ACME', decimals: 6n, standards: ['mip-0004'] });
    expect(r.groups).toHaveLength(1);
    expect(r.pages).toBe(2); // one page with the event, then the empty page that proves the end
    // The stored report is exactly what this code produces from the recorded tape.
    expect(`${toJson(r, 1)}\n`).toBe(readFileSync(join(dir, 'list-spike.result.json'), 'utf8'));
  });
});

describe('indexer data with trailing zero bytes dropped (MIP "Consuming": zero extension)', () => {
  /** The recorded tape with every MiscContractEvent name/payload trimmed of its trailing zero bytes. */
  const trimmedReplay = (name: string) => {
    const trim = (h: string) => h.replace(/(00)+$/u, '');
    const tape = loadTape(join(dir, `${name}.tape.json`));
    let trimmed = 0;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.name === 'string' && typeof o.payload === 'string' && o.payload.length === 512) {
          o.name = trim(o.name);
          o.payload = trim(o.payload);
          trimmed++;
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(tape);
    expect(trimmed).toBeGreaterThan(0);
    return new HttpClient({ fetch: replayFetch(tape), attempts: 1 });
  };

  it('verify: the trimmed event is zero-extended, equals the raw log op and is A1', async () => {
    const r = await verifyEmission({
      profile,
      contract: SPIKE,
      tx: PUBLISH,
      http: trimmedReplay('verify-spike-publish'),
      expect: { metadata: A1_META },
    });
    expect(r.outcome).toBe('ok');
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.events[0]).toMatchObject({ inRawTransaction: true, classification: { result: 'accept', kind: 3 } });
    expect(r.events[0]!.name).toHaveLength(64);
    expect(r.events[0]!.payload).toHaveLength(512);
  });

  it('list: the trimmed event gives the same identity', async () => {
    const r = await listMetadata({ profile, contract: SPIKE, toBlock: 710820, http: trimmedReplay('list-spike') });
    expect(r.counts).toEqual({ events: 1, accepted: 1, rejected: 0, ignored: 0 });
    expect(r.identities[0]!.common).toEqual({ name: 'Acme Token', symbol: 'ACME', decimals: 6n, standards: ['mip-0004'] });
  });
});

describe('scanner', () => {
  it('replays blocks 710800..710820 (polling) to the recorded state', async () => {
    const t = mkdtempSync(join(tmpdir(), 'scan-'));
    temps.push(t);
    const r = await scan({ profile, stateDir: t, fromHeight: 710800, toHeight: 710820, poll: true, http: replay('scan-710800-710820') });
    const recorded = JSON.parse(readFileSync(join(dir, 'scan-710800-710820.result.json'), 'utf8')) as ScanState;
    const strip = (s: ScanState) => ({ ...s, updatedAt: '' });
    expect(strip(r.state)).toEqual(strip(recorded));
    expect(r.state.events[SPIKE]).toHaveLength(1);
    expect(r.state.events[SPIKE]![0]).toMatchObject({ result: 'accept', kind: 3, block: { height: 710810 } });
    expect(strip(loadState(t)!)).toEqual(strip(recorded));
  });

  it('a split scan equals a single scan (resumability) and refuses gaps / wrong parents', () => {
    const tape = loadTape(join(dir, 'scan-710800-710820.tape.json'));
    const blocks = tape
      .map((e) => (e.response as { data?: { block?: ScannedBlock } }).data?.block)
      .filter((b): b is ScannedBlock => b !== undefined && b !== null && 'transactions' in b);
    expect(blocks.map((b) => b.height)).toEqual(Array.from({ length: 21 }, (_, i) => 710800 + i));
    const one = newState(profile, profile.genesisHash!, 710800);
    for (const b of blocks) applyBlock(one, b);
    const a = newState(profile, profile.genesisHash!, 710800);
    for (const b of blocks.slice(0, 7)) applyBlock(a, b);
    const resumed = JSON.parse(JSON.stringify(a)) as ScanState; // as if reloaded from disk
    for (const b of blocks.slice(7)) applyBlock(resumed, b);
    expect({ ...resumed, updatedAt: '' }).toEqual({ ...one, updatedAt: '' });
    const g = newState(profile, profile.genesisHash!, 710800);
    expect(() => applyBlock(g, blocks[1]!)).toThrow(ScanError);
    applyBlock(g, blocks[0]!);
    expect(() => applyBlock(g, { ...blocks[1]!, parent: { hash: 'bb'.repeat(32) } })).toThrow(/parent/);
  });

  it('builds the color table from mint transactions and resolves colors', () => {
    const m = JSON.parse(readFileSync(join(dir, 'mint-txs.json'), 'utf8')) as {
      contractAddress: string;
      transactions: { hash: string; height: number; blockHash: string; raw: string; transactionResult: never }[];
      expected: { color: string; domainSep: string };
    };
    const s = newState(profile, profile.genesisHash!, 508540);
    const blockAt = (h: number): ScannedBlock => {
      const t = m.transactions.find((x) => x.height === h);
      return {
        height: h,
        hash: (t?.blockHash ?? h.toString(16)).padStart(64, '0'),
        timestamp: 0,
        parent: null,
        transactions: t
          ? [
              {
                __typename: 'RegularTransaction',
                id: 1,
                hash: t.hash,
                raw: t.raw,
                contractActions: [{ __typename: 'ContractCall', address: m.contractAddress }],
                transactionResult: t.transactionResult,
              },
            ]
          : [],
      };
    };
    for (let h = 508540; h <= 508544; h++) applyBlock(s, blockAt(h));
    expect(Object.keys(s.colors)).toEqual([m.expected.color]);
    const e = s.colors[m.expected.color]!;
    expect(e).toMatchObject({ contractAddress: m.contractAddress, domainSep: m.expected.domainSep });
    expect(e.shielded).toMatchObject({ mints: 1, amount: '1000', firstMint: { height: 508540 } });
    expect(e.unshielded).toMatchObject({ mints: 1, amount: '2000', firstMint: { height: 508544 } });
    const l = lookupColor(s, m.expected.color);
    expect(l.identities.map((i) => i.kind)).toEqual([1, 2]);
    expect(lookupColor(s, m.expected.color, 2).identities).toEqual([
      { contractAddress: m.contractAddress, domainSep: m.expected.domainSep, kind: 2, mintedInRange: true },
    ]);
    const miss = lookupColor(s, 'ab'.repeat(32));
    expect(miss.found).toBe(false);
    expect(miss.scanned).toMatchObject({ from: 508540, to: 508544 });
    // a FAILED transaction mints nothing
    const f = newState(profile, profile.genesisHash!, 508540);
    const failed = blockAt(508540);
    failed.transactions[0]!.transactionResult = { status: 'FAILURE', segments: null };
    applyBlock(f, failed);
    expect(f.colors).toEqual({});

    // Lookup of a withdrawn identity (MIP "Applying records": not referenced at all) resolves exactly like one that
    // was never described: the color still maps to its mint, but there is no metadata for that kind.
    const ds = Buffer.from(m.expected.domainSep, 'hex');
    const ev = (height: number, kind: number, records: Parameters<typeof encodePayload>[1]) => ({
      block: { height },
      txIndex: 0,
      eventIndex: kind,
      name: Buffer.from(EVENT_NAME).toString('hex'),
      payload: Buffer.from(encodePayload({ domainSep: ds, kind }, records)).toString('hex'),
    });
    const meta = (evs: ReturnType<typeof ev>[]) => {
      const ids = reduceScannedEvents(profile.id, m.contractAddress, evs).identities();
      return l.identities.map((i) => ids.find((x) => x.domainSep === i.domainSep && x.kind === i.kind)?.common ?? null);
    };
    const published = [
      ev(508545, 1, commonRecords({ name: 'Shield', symbol: 'SHD' })),
      ev(508545, 2, commonRecords({ name: 'Open', symbol: 'OPN' })),
    ];
    expect(meta(published)).toEqual([
      { name: 'Shield', symbol: 'SHD' },
      { name: 'Open', symbol: 'OPN' },
    ]);
    const withdrawn = [...published, ev(508546, 1, withdrawRecords())];
    expect(meta(withdrawn)).toEqual([null, { name: 'Open', symbol: 'OPN' }]);
    expect(meta(withdrawn)).toEqual(meta([published[1]!])); // = kind 1 never described
  });
});
