// SPDX-License-Identifier: Apache-2.0
//
// Byte equality (spec FR-021, SC-002): the compiled module circuits — default typed builders AND the
// pure-circuit alternative — are executed in compact-runtime 0.20.0 and the Misc event each emits is
// compared with the S1 fixtures (vectors/payload/*.json, vectors/state/S1*.json). Every emitted
// payload is then decoded by the reference codec (round trip).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyEvent,
  commonRecords,
  decodePayload,
  encodePayload,
  EVENT_NAME,
  fromHex,
  Kind,
  record,
  splitMiscData,
  toHex,
  ValType,
  withdrawRecords,
} from '@mip0018/codec';
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulator, type ObservedMisc } from '../src/testing/index.ts';
import { CONSTRUCTIONS, compileTestContract } from './lib/contracts.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');

type FixtureRecord = { offset: number; key_hex: string; valType: number; value_hex: string; decoded?: string };
type PayloadFixture = {
  id: string;
  event: { name_hex: string; payload_hex: string };
  expect: { result: string; header: { domainSep: string; kind: number }; records: FixtureRecord[]; contentEnd: number };
};

/** A payload vector; `key_text`/`value_text` are readability annotations (never compared) and are dropped. */
const payloadFixture = (id: string): PayloadFixture => {
  const f = JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', `${id}.json`), 'utf8')) as PayloadFixture;
  f.expect.records = f.expect.records.map(({ offset, key_hex, valType, value_hex, decoded }) => ({
    offset,
    key_hex,
    valType,
    value_hex,
    ...(decoded !== undefined ? { decoded } : {}),
  }));
  return f;
};

/** S1 state vectors: one event each; the expected records come from decoding it with the codec. */
const stateFixture = (id: string): PayloadFixture => {
  const s = JSON.parse(readFileSync(join(REPO, 'vectors', 'state', `${id}.json`), 'utf8')) as {
    id: string;
    steps: { name_hex: string; payload_hex: string }[];
  };
  expect(s.steps).toHaveLength(1);
  const step = s.steps[0]!;
  const d = decodePayload(fromHex(step.payload_hex));
  if (!d.ok) throw new Error(`${id}: fixture payload does not decode`);
  return {
    id,
    event: { name_hex: step.name_hex, payload_hex: step.payload_hex },
    expect: {
      result: 'accept',
      header: { domainSep: toHex(d.header.domainSep), kind: d.header.kind },
      records: d.records.map((r) => ({
        offset: r.offset,
        key_hex: toHex(r.key),
        valType: r.valType,
        value_hex: toHex(r.value),
        ...(r.integer !== undefined ? { decoded: r.integer.toString() } : {}),
      })),
      contentEnd: d.contentEnd,
    },
  };
};

/** Circuit arguments from a fixture: (domainSep, kind, key1, value1, ...); a uint is a bigint, a Null has no value. */
const argsFor = (f: PayloadFixture): unknown[] => {
  const args: unknown[] = [fromHex(f.expect.header.domainSep), BigInt(f.expect.header.kind)];
  for (const r of f.expect.records) {
    args.push(fromHex(r.key_hex));
    if (r.valType === ValType.UInt) args.push(BigInt(r.decoded!));
    else if (r.valType !== ValType.Null) args.push(fromHex(r.value_hex));
  }
  return args;
};

/** Asserts one Misc event, emitted by the contract, named EVENT_NAME, with the expected payload; returns it. */
const single = (misc: readonly ObservedMisc[], address: string, payloadHex: string): ObservedMisc => {
  expect(misc).toHaveLength(1);
  const ev = misc[0]!;
  expect(ev.address).toBe(address);
  expect(toHex(ev.name)).toBe(toHex(EVENT_NAME));
  expect(toHex(ev.payload)).toBe(payloadHex);
  return ev;
};

/** Round trip: the emitted payload is accepted by the reference codec with exactly the fixture's records. */
const roundTrip = (ev: ObservedMisc, f: PayloadFixture) => {
  const c = classifyEvent({ type: 'Misc', name: ev.name, payload: ev.payload });
  expect(c.result).toBe('accept');
  if (c.result !== 'accept') return;
  expect({ domainSep: toHex(c.header.domainSep), kind: c.header.kind }).toEqual(f.expect.header);
  expect(c.contentEnd).toBe(f.expect.contentEnd);
  expect(
    c.records.map((r) => ({
      offset: r.offset,
      key_hex: toHex(r.key),
      valType: r.valType,
      value_hex: toHex(r.value),
      ...(r.integer !== undefined ? { decoded: r.integer.toString() } : {}),
    })),
  ).toEqual(f.expect.records);
};

const PAYLOAD_VECTORS = ['A1', 'A2a', 'A2b', 'A3a', 'A3b', 'A3c', 'A4a', 'A4b', 'A5a', 'A5b', 'A5c'];
const STATE_VECTORS = ['S1a', 'S1b'];
const DS11 = new Uint8Array(32).fill(0x11);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe.each(CONSTRUCTIONS)('$label', ({ contract }) => {
  let managed: string;
  beforeAll(() => {
    managed = compileTestContract(contract);
  }, 120_000);

  const deploy = () => Simulator.deploy(managed);

  it.each([...PAYLOAD_VECTORS, ...STATE_VECTORS])('%s: emits the fixture bytes and the codec accepts them', async (id) => {
    const f = STATE_VECTORS.includes(id) ? stateFixture(id) : payloadFixture(id);
    const sim = await deploy();
    const out = await sim.call(id, ...argsFor(f));
    const ev = single(out.misc, sim.address, f.event.payload_hex);
    expect(toHex(ev.name)).toBe(f.event.name_hex);
    roundTrip(ev, f);
    // The runtime atom is name ‖ payload with trailing zeros trimmed; the codec's splitter agrees.
    const atom = new Uint8Array([...ev.name, ...ev.payload]).slice(0, ev.rawLength);
    expect(splitMiscData(atom)).toEqual({ name: ev.name, payload: ev.payload });
    expect(out.events).toHaveLength(1);
  });

  it('A1 via commonFieldsWithStandards (runtime values)', async () => {
    const f = payloadFixture('A1');
    const sim = await deploy();
    const out = await sim.call('A1_common', DS11, 3n, utf8('Acme Token'), utf8('ACME'), 6n, utf8('mip-0004'));
    roundTrip(single(out.misc, sim.address, f.event.payload_hex), f);
  });

  it('A1 as a literal publishMetadata() (no arguments)', async () => {
    const f = payloadFixture('A1');
    const sim = await deploy();
    const out = await sim.call('A1_literal');
    const ev = single(out.misc, sim.address, f.event.payload_hex);
    expect(ev.rawLength).toBe(32 + 95); // MIP Appendix A: content ends at 95; padding trimmed on the wire
  });

  it('S1a via nameRecord / nullRecord convenience builders', async () => {
    const f = stateFixture('S1a');
    const sim = await deploy();
    const out = await sim.call('S1a_common', DS11, utf8('A'), utf8('B'));
    roundTrip(single(out.misc, sim.address, f.event.payload_hex), f);
  });

  it.each([1n, 2n, 3n])(
    'withdraw(kind %s) equals the codec withdrawRecords() byte for byte (four Nulls, 72 bytes of content)',
    async (kind) => {
      const sim = await deploy();
      const ds = new Uint8Array(32).map((_, i) => i);
      const out = await sim.call('withdraw', ds, kind);
      const want = encodePayload({ domainSep: ds, kind: Number(kind) }, withdrawRecords());
      const ev = single(out.misc, sim.address, toHex(want));
      const d = decodePayload(ev.payload);
      expect(d.ok && d.contentEnd).toBe(72); // 33-byte header + 39 bytes of records, the rest zero
      expect(d.ok && d.records.map((r) => [new TextDecoder().decode(r.key), r.valType, r.value.length])).toEqual([
        ['name', ValType.Null, 0],
        ['symbol', ValType.Null, 0],
        ['decimals', ValType.Null, 0],
        ['standards', ValType.Null, 0],
      ]);
    },
  );

  it.each([1n, 2n, 3n])('nullRecord deletes a single key: Null at "name" (kind %s) equals the codec tombstone("name")', async (kind) => {
    const sim = await deploy();
    const ds = new Uint8Array(32).map((_, i) => 255 - i);
    const out = await sim.call('deleteName', ds, kind);
    single(out.misc, sim.address, toHex(encodePayload({ domainSep: ds, kind: Number(kind) }, [record.tombstone('name')])));
  });

  it('commonFields (no standards) equals the codec', async () => {
    const sim = await deploy();
    const out = await sim.call('commonFields', DS11, 1n, utf8('Acme Token'), utf8('ACME'), 18n);
    const want = encodePayload(
      { domainSep: DS11, kind: Kind.NativeShielded },
      commonRecords({ name: 'Acme Token', symbol: 'ACME', decimals: 18 }),
    );
    single(out.misc, sim.address, toHex(want));
  });

  it('uriRecord equals the codec', async () => {
    const sim = await deploy();
    const uri = 'https://acme.example/img.png';
    expect(utf8(uri)).toHaveLength(28);
    const out = await sim.call('uriRecord', DS11, 2n, utf8('uri'), utf8(uri));
    const want = encodePayload({ domainSep: DS11, kind: Kind.NativeUnshielded }, [record.uri('uri', uri)]);
    single(out.misc, sim.address, toHex(want));
  });

  it.each([0n, 4n, 255n])('header rejects kind %s (assertion; nothing emitted)', async (kind) => {
    const sim = await deploy();
    await expect(sim.call('withdraw', DS11, kind)).rejects.toThrow(/MIP-0018: kind must be 1, 2 or 3/u);
  });

  it('constants equal the codec constants', async () => {
    const sim = await deploy();
    const pure = sim.module.pureCircuits;
    expect(toHex(pure.eventName!() as Uint8Array)).toBe(toHex(EVENT_NAME));
    expect((pure.constants!() as bigint[]).map(Number)).toEqual([
      Kind.NativeShielded,
      Kind.NativeUnshielded,
      Kind.Ledger,
      ValType.Bytes,
      ValType.Utf8,
      ValType.UInt,
      ValType.Json,
      ValType.Uri,
      ValType.Null,
    ]);
  });
});
