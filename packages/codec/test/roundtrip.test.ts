// Round trip: encode(decode(p)) == p for every accepted vector (the zero-extended p for the informative vectors whose
// payload has its trailing zero bytes dropped), and decode(encode(x)) == x for generated records.
import { loadVectors } from '@mip0018/vectors/runner';
import { describe, expect, it } from 'vitest';
import { decodePayload, encodePayload, fromHex, toHex, zeroExtend } from '../src/index.ts';
import { validRecords } from './gen.ts';
import { makeRng } from './prng.ts';

const accepted = loadVectors().filter((v) => v.entry.kind === 'payload' && (v.data.expect as { result: string }).result === 'accept');

describe('round trip', () => {
  it('covers every accepted payload vector (normative and informative)', () => {
    expect(accepted.length).toBe(11 + 16 + 4); // A1-A5 sub-cases + 16 accepted URI cases + 4 trimmed (INF-ZEXT-1…4)
  });
  for (const v of accepted) {
    it(`encode(decode(${v.entry.id})) is the fixture`, () => {
      const p = fromHex((v.data.event as { payload_hex: string }).payload_hex);
      const d = decodePayload(p);
      expect(d.ok).toBe(true);
      if (d.ok) expect(toHex(encodePayload(d.header, d.records))).toBe(toHex(zeroExtend(p, 256)!));
    });
  }

  it('decode(encode(x)) == x for 20 000 generated record lists', () => {
    const r = makeRng(0x52545450);
    for (let i = 0; i < 20_000; i++) {
      const header = { domainSep: r.bytes(32), kind: 1 + r.int(3) };
      const records = validRecords(r);
      const d = decodePayload(encodePayload(header, records));
      if (!d.ok) throw new Error(`generated payload rejected: ${d.reason}`);
      expect(toHex(d.header.domainSep)).toBe(toHex(header.domainSep));
      expect(d.header.kind).toBe(header.kind);
      expect(d.records.map((x) => [toHex(x.key), x.valType, toHex(x.value)])).toEqual(
        records.map((x) => [toHex(x.key), x.valType, toHex(x.value)]),
      );
    }
  });
});
