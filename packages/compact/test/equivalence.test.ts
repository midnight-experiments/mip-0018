// SPDX-License-Identifier: Apache-2.0
//
// Typed vs pure equivalence: for generated shapes (one record per value size 1..219, and random
// 2-4-record shapes with uint8 / uint128 / Null records) and random values, the default typed module
// and the pure-circuit alternative emit identical payloads, equal to @mip0018/codec encodePayload.

import { join } from 'node:path';
import { encodePayload, encodeUint, toHex, ValType, type MetadataRecord } from '@mip0018/codec';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureCompiled, Simulator } from '../src/testing/index.ts';
import { MANAGED_DIR, SRC_DIR } from './lib/contracts.ts';
import { MULTI, prng, pureSource, shapes, typedSource, writeIfChanged, type RecordShape } from './lib/generate.ts';

const ALL = shapes();
const GEN = join(MANAGED_DIR, '.gen');

const VALTYPE: Record<RecordShape['kind'], number> = {
  bytes: ValType.Bytes,
  utf8: ValType.Utf8,
  json: ValType.Json,
  uri: ValType.Uri,
  uint8: ValType.UInt,
  uint128: ValType.UInt,
  null: ValType.Null,
};

/** Random arguments and the codec records they must produce. */
const sample = (records: RecordShape[], rnd: () => number) => {
  const byte = () => Math.floor(rnd() * 256);
  const bytes = (n: number) => Uint8Array.from({ length: n }, byte);
  const ascii = (n: number, alphabet: string) =>
    new TextEncoder().encode(Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
  const domainSep = bytes(32);
  const kind = 1 + Math.floor(rnd() * 3);
  const args: unknown[] = [domainSep, BigInt(kind)];
  const want: MetadataRecord[] = [];
  for (const r of records) {
    const key = bytes(r.k);
    args.push(key);
    let value: Uint8Array;
    if (r.kind === 'uint8' || r.kind === 'uint128') {
      const n = bytes(r.v).reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
      args.push(n);
      value = encodeUint(n, r.v);
    } else if (r.kind === 'null') {
      value = new Uint8Array(0);
    } else {
      if (r.kind === 'bytes') value = bytes(r.v);
      else if (r.kind === 'utf8') value = ascii(r.v, printable);
      else if (r.kind === 'json')
        value = r.v === 1 ? new TextEncoder().encode('7') : new Uint8Array([0x22, ...ascii(r.v - 2, 'abcdefghij KLMNOP-_.'), 0x22]);
      else value = new Uint8Array([0x78, 0x3a, ...ascii(r.v - 2, 'abcdefghijklmnopqrstuvwxyz0123456789-._~')]);
      args.push(value);
    }
    want.push({ key, valType: VALTYPE[r.kind], value });
  }
  return { args, expected: encodePayload({ domainSep, kind }, want) };
};

describe('equivalence: typed constructor vs pure circuits vs codec', () => {
  const managed: Record<'typed' | 'pure', string> = { typed: '', pure: '' };
  beforeAll(() => {
    writeIfChanged(join(GEN, 'EquivalenceTyped.compact'), typedSource(ALL));
    writeIfChanged(join(GEN, 'EquivalencePure.compact'), pureSource(ALL));
    managed.typed = ensureCompiled(join(GEN, 'EquivalenceTyped.compact'), join(MANAGED_DIR, 'EquivalenceTyped'), { dependsOn: [SRC_DIR] });
    managed.pure = ensureCompiled(join(GEN, 'EquivalencePure.compact'), join(MANAGED_DIR, 'EquivalencePure'), { dependsOn: [SRC_DIR] });
  }, 600_000);

  it(`covers value sizes 1..219 and ${MULTI} multi-record shapes`, () => {
    const single = ALL.filter((s) => s.records.length === 1).map((s) => s.records[0]!.v);
    expect(single).toEqual(Array.from({ length: 219 }, (_, i) => i + 1));
    expect(ALL.filter((s) => s.records.length > 1)).toHaveLength(MULTI);
    const kinds = new Set(ALL.flatMap((s) => s.records.map((r) => r.kind)));
    expect([...kinds].sort()).toEqual(['bytes', 'json', 'null', 'uint128', 'uint8', 'uri', 'utf8']);
  });

  it('every shape: typed == pure == codec, for 3 random inputs each', async () => {
    const typed = await Simulator.deploy(managed.typed);
    const pure = await Simulator.deploy(managed.pure);
    const rnd = prng(20261001);
    let checked = 0;
    for (const s of ALL) {
      for (let i = 0; i < 3; i++) {
        const { args, expected } = sample(s.records, rnd);
        const a = await typed.call(s.name, ...args);
        const b = await pure.call(s.name, ...args);
        expect(a.misc, s.name).toHaveLength(1);
        expect(b.misc, s.name).toHaveLength(1);
        const hexA = toHex(a.misc[0]!.payload);
        expect(hexA, `${s.name} typed vs pure`).toBe(toHex(b.misc[0]!.payload));
        expect(hexA, `${s.name} vs codec`).toBe(toHex(expected));
        checked++;
      }
    }
    expect(checked).toBe(3 * ALL.length);
  }, 300_000);
});
