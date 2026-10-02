// SPDX-License-Identifier: Apache-2.0
//
// TEST-ONLY raw emitter in compact-runtime 0.20.0: the owner emits exactly the given name/payload
// (negative R-vectors, ignore names, capacity A2, two events in one call for S7); the reference codec
// classifies each as the vector says; a non-owner call fails its assertion and emits nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent, fromHex, toHex } from '@mip0018/codec';
import { Simulator } from '@mip0018/compact/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileRawEmitter, ownerArg, witnesses, type RawEmitterPrivateState } from '../src/contract.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
type Fixture = { event: { type: string; name_hex: string; payload_hex: string }; expect: { result: string; reason?: string } };
const fixture = (id: string) => JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', `${id}.json`), 'utf8')) as Fixture;

const OWNER = new Uint8Array(32).fill(0x0a);
const OTHER = new Uint8Array(32).fill(0x0b);
const ps = (k: Uint8Array): RawEmitterPrivateState => ({ ownableSecretKey: k });

let managed: string;
beforeAll(() => {
  managed = compileRawEmitter();
}, 300_000);

const deploy = async () => {
  const probe = await Simulator.deploy<RawEmitterPrivateState>(managed, {
    witnesses,
    privateState: ps(OWNER),
    args: [ownerArg(new Uint8Array(32).fill(1))],
  });
  const owner = probe.module.pureCircuits.accountId!(OWNER) as Uint8Array;
  return Simulator.deploy<RawEmitterPrivateState>(managed, { witnesses, privateState: ps(OWNER), args: [ownerArg(owner)] });
};

// Every payload vector a Misc event can carry (I3 is another event type: not producible here).
const IDS = [
  'A1',
  'A2a',
  'A2b',
  'R1',
  'R2a',
  'R2b',
  'R3a',
  'R3b',
  'R4a',
  'R4c',
  'R4d',
  'R5a',
  'R5d',
  'R5e',
  'R5g',
  'R5h',
  'R6a',
  'R6b',
  'I1a',
  'I1b',
  'I2a',
  'I2b',
];

describe('RawEmitter (test-only)', () => {
  it.each(IDS)('owner emits vector %s byte-for-byte; the codec classifies it as the vector says', async (id) => {
    const f = fixture(id);
    const sim = await deploy();
    const out = await sim.call('emitRaw', fromHex(f.event.name_hex), fromHex(f.event.payload_hex));
    expect(out.misc).toHaveLength(1);
    const ev = out.misc[0]!;
    expect(ev.address).toBe(sim.address);
    expect(toHex(ev.name)).toBe(f.event.name_hex);
    expect(toHex(ev.payload)).toBe(f.event.payload_hex);
    const c = classifyEvent({ type: 'Misc', name: ev.name, payload: ev.payload });
    expect(c.result).toBe(f.expect.result);
    if (f.expect.reason !== undefined) expect('reason' in c ? c.reason : undefined).toBe(f.expect.reason);
  });

  it('trailing zero bytes are trimmed on the wire, content or padding alike; zero-extension restores them', async () => {
    const sim = await deploy();
    const a2b = fixture('A2b'); // ends with value byte 0xda: nothing to trim
    expect((await sim.call('emitRaw', fromHex(a2b.event.name_hex), fromHex(a2b.event.payload_hex))).misc[0]!.rawLength).toBe(288);
    const a2a = fixture('A2a'); // 256 content bytes ending with valType 00, valLen 00 (empty value)
    const out = await sim.call('emitRaw', fromHex(a2a.event.name_hex), fromHex(a2a.event.payload_hex));
    expect(out.misc[0]!.rawLength).toBe(286);
    expect(toHex(out.misc[0]!.payload)).toBe(a2a.event.payload_hex);
    const r1 = await sim.call('emitRaw', fromHex(fixture('R1').event.name_hex), new Uint8Array(256));
    expect(r1.misc[0]!.rawLength).toBe(27); // "mip-0018:token-metadata[v1]" without its 5 zero bytes
    expect(toHex(r1.misc[0]!.payload)).toBe('00'.repeat(256));
  });

  it('emitTwo: a malformed and a valid event in one call, in order (MIP test S7)', async () => {
    const sim = await deploy();
    const bad = fixture('R4a');
    const good = fixture('A1');
    const out = await sim.call(
      'emitTwo',
      fromHex(bad.event.name_hex),
      fromHex(bad.event.payload_hex),
      fromHex(good.event.name_hex),
      fromHex(good.event.payload_hex),
    );
    expect(out.misc.map((e) => toHex(e.payload))).toEqual([bad.event.payload_hex, good.event.payload_hex]);
    expect(out.misc.map((e) => classifyEvent({ type: 'Misc', ...e }).result)).toEqual(['reject', 'accept']);
  });

  it.each([
    ['emitRaw', 2],
    ['emitTwo', 4],
  ] as const)('a non-owner cannot call %s (assertion; nothing emitted)', async (circuit, n) => {
    const sim = await deploy();
    sim.currentPrivateState = ps(OTHER);
    const args = Array.from({ length: n }, (_, i) => new Uint8Array(i % 2 === 0 ? 32 : 256).fill(1));
    await expect(sim.call(circuit, ...args)).rejects.toThrow(/Ownable: caller is not the owner/u);
    sim.currentPrivateState = ps(OWNER);
    expect((await sim.call(circuit, ...args)).misc).toHaveLength(n / 2);
  });
});
