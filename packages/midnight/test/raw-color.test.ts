// SPDX-License-Identifier: Apache-2.0
//
// Raw decoding of recorded Stagenet transactions and the color function.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenTypeHex, tokenTypeSha256, ColorError } from '../src/color.ts';
import {
  applied,
  decodeEventRaw,
  decodeTransaction,
  miscLogsOf,
  partApplied,
  readLogItem,
  transactionHashInExtrinsic,
} from '../src/raw.ts';
import type { Exchange } from './support/cassette.ts';

const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'stagenet', f), 'utf8'));
const SPIKE = '18097aeb608f35d83a65b2cad987084c97c6e9d1dc02973f2a6f6cc2fcdd76e1';
const A1 =
  '11'.repeat(32) +
  '03' +
  '046e616d65010a41636d6520546f6b656e' +
  '0673796d626f6c010441434d45' +
  '08646563696d616c73020106' +
  '097374616e646172647301086d69702d30303034';
const A1_PAYLOAD = A1.padEnd(512, '0');
const NAME = Buffer.from('mip-0018:token-metadata[v1]').toString('hex').padEnd(64, '0');

function rawOf(tape: Exchange[], hash: string): { raw: string; transactionResult: never; block: { hash: string } } {
  for (const e of tape) {
    const t = (e.response as { data?: { transactions?: { hash: string; raw: string }[] } }).data?.transactions?.[0];
    if (t?.hash === hash) return t as never;
  }
  throw new Error(`no raw for ${hash}`);
}

describe('raw transaction decoding (recorded Stagenet)', () => {
  const tape = fx('verify-spike-publish.tape.json') as Exchange[];
  const publish = rawOf(tape, '223050717f704fe47d1bd0b6b91da8ea248139d2d15a23a2eab7cf07d5a51418');

  it('recomputes the hash and finds the A1 log op (zero-extended to 288 bytes)', () => {
    const d = decodeTransaction(publish.raw);
    expect(d.hash).toBe('223050717f704fe47d1bd0b6b91da8ea248139d2d15a23a2eab7cf07d5a51418');
    expect(d.identifiers).toHaveLength(2);
    const logs = miscLogsOf(d, SPIKE);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      phase: 'guaranteed',
      segment: 30299,
      entryPoint: 'publishMetadata',
      version: 1,
      eventType: 'misc',
      name: NAME,
      payload: A1_PAYLOAD,
    });
    expect(d.mints).toEqual([]);
    expect(applied(d, { status: 'SUCCESS', segments: null }).logs).toHaveLength(1);
    expect(applied(d, { status: 'FAILURE', segments: null }).logs).toHaveLength(0);
  });

  it('finds the transaction inside its node extrinsic', () => {
    const blockExchange = tape.find((e) => (e.body as { method?: string })?.method === 'chain_getBlock');
    const xs = (blockExchange!.response as { result: { block: { extrinsics: string[] } } }).result.block.extrinsics;
    const hits = xs.map((x) => transactionHashInExtrinsic(x));
    expect(hits[3]).toBe('223050717f704fe47d1bd0b6b91da8ea248139d2d15a23a2eab7cf07d5a51418');
    expect(hits.filter(Boolean)).toHaveLength(1);
  });

  it('decodes the indexer event envelope (source segment, contract, entry point)', () => {
    const ev = (
      tape.find((e) => (e.response as { data?: { contractEvents?: unknown[] } }).data?.contractEvents)!.response as {
        data: { contractEvents: { raw: string }[] };
      }
    ).data.contractEvents[0]!;
    expect(decodeEventRaw(ev.raw)).toEqual({
      transactionHash: '223050717f704fe47d1bd0b6b91da8ea248139d2d15a23a2eab7cf07d5a51418',
      logicalSegment: 0,
      physicalSegment: 30299,
      tag: 'contractLog',
      contractAddress: SPIKE,
      entryPoint: 'publishMetadata',
      version: 1,
      eventType: 'misc',
    });
  });

  it('decodes shielded and unshielded mints and their color', () => {
    const m = fx('mint-txs.json') as {
      contractAddress: string;
      transactions: {
        entryPoint: string;
        hash: string;
        raw: string;
        transactionResult: never;
        unshieldedCreatedOutputs: { tokenType: string }[];
      }[];
      expected: { domainSep: string; color: string };
    };
    for (const t of m.transactions) {
      const d = decodeTransaction(t.raw);
      expect(d.hash).toBe(t.hash);
      const mints = applied(d, t.transactionResult).mints;
      expect(mints).toHaveLength(1);
      expect(mints[0]).toMatchObject({
        kind: t.entryPoint === 'mintShielded' ? 'shielded' : 'unshielded',
        domainSep: m.expected.domainSep,
        contractAddress: m.contractAddress,
        amount: t.entryPoint === 'mintShielded' ? 1000n : 2000n,
        phase: 'guaranteed',
      });
      expect(tokenTypeHex(mints[0]!.domainSep, mints[0]!.contractAddress)).toBe(m.expected.color);
      if (t.entryPoint === 'mintUnshielded') expect(t.unshieldedCreatedOutputs[0]!.tokenType).toBe(m.expected.color);
    }
  });
});

describe('colors', () => {
  it('rawTokenType equals the independent SHA-256 derivation', () => {
    const vectors: [string, string][] = [
      [
        '756d6272613a6461757200000000000000000000000000000000000000000000',
        '3ad541b2dbbaeb69b2381bec19b0d9211925726f8784b8bff1b87b92d6a09256',
      ],
      ['11'.repeat(32), SPIKE],
      ['00'.repeat(32), 'ff'.repeat(32)],
    ];
    for (const [ds, addr] of vectors) expect(tokenTypeSha256(ds, addr)).toBe(tokenTypeHex(ds, addr));
    expect(tokenTypeHex(vectors[0]![0], vectors[0]![1])).toBe('00b357a6d3d7a08be132a3ff81c48a54c9a566b4e73eedc285a34c6d2c51d325');
  });

  it('binds the color to both inputs and refuses wrong sizes', () => {
    const a = tokenTypeHex('11'.repeat(32), SPIKE);
    expect(tokenTypeHex('12' + '11'.repeat(31), SPIKE)).not.toBe(a);
    expect(tokenTypeHex('11'.repeat(32), '19' + SPIKE.slice(2))).not.toBe(a);
    expect(() => tokenTypeHex('11'.repeat(31), SPIKE)).toThrow(ColorError);
    expect(() => tokenTypeHex('11'.repeat(32), 'abcd')).toThrow();
  });
});

describe('segment rules and log items', () => {
  it('fallible parts apply only in a successful segment', () => {
    expect(partApplied('guaranteed', 5, { status: 'PARTIAL_SUCCESS', segments: [{ id: 5, success: false }] })).toBe(true);
    expect(partApplied('fallible', 5, { status: 'PARTIAL_SUCCESS', segments: [{ id: 5, success: false }] })).toBe(false);
    expect(partApplied('fallible', 5, { status: 'PARTIAL_SUCCESS', segments: [{ id: 5, success: true }] })).toBe(true);
    expect(partApplied('fallible', 5, { status: 'SUCCESS', segments: null })).toBe(true);
    expect(partApplied('guaranteed', 5, { status: 'FAILURE', segments: null })).toBe(false);
    expect(partApplied('guaranteed', 5, undefined)).toBe(false);
  });

  it('reads Misc items, trimmed or not, and refuses other shapes', () => {
    const cell = (b: number[]) => ({ tag: 'cell', content: { value: [Uint8Array.from(b)], alignment: [] } });
    const trimmed = [...Buffer.from(NAME, 'hex'), 0x11, 0x03];
    const item = readLogItem({ tag: 'array', content: [cell([1]), cell([10]), cell(trimmed)] });
    expect(item.eventType).toBe('misc');
    expect(item.name).toBe(NAME);
    expect(item.payload).toBe(('11' + '03').padEnd(512, '0'));
    expect(readLogItem({ tag: 'array', content: [cell([1]), cell([10]), cell(new Array(289).fill(1))] }).undecodable).toMatch(/> 288/);
    const other = readLogItem({ tag: 'array', content: [cell([1]), cell([6]), cell([1])] });
    expect(other.eventType).toBe('unshielded-mint');
    expect(other.name).toBeUndefined();
    expect(readLogItem({ tag: 'cell', content: { value: [] } }).undecodable).toBeDefined();
    expect(
      readLogItem({
        tag: 'array',
        content: [cell([1]), cell([10]), { tag: 'cell', content: { value: [new Uint8Array(1), new Uint8Array(1)] } }],
      }).undecodable,
    ).toMatch(/single cell atom/);
  });
});
