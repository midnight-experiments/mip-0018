// encodePayload: exact bytes for valid input; refuses anything a conforming consumer would reject.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR } from '@mip0018/vectors/common';
import { describe, expect, it } from 'vitest';
import {
  commonRecords,
  encodePayload,
  EVENT_NAME,
  EVENT_NAME_TEXT,
  InvalidHeader,
  InvalidRecord,
  PayloadTooLarge,
  record,
  recordsSize,
  toHex,
  withdrawRecords,
} from '../src/index.ts';

const D11 = new Uint8Array(32).fill(0x11);
const bin = (id: string) => toHex(readFileSync(join(VECTORS_DIR, `payload/${id}.bin`)));

describe('encodePayload', () => {
  it('EVENT_NAME is pad(32, "mip-0018:token-metadata[v1]")', () => {
    expect(EVENT_NAME_TEXT).toBe('mip-0018:token-metadata[v1]');
    expect(toHex(EVENT_NAME)).toBe('6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000');
  });

  it('A1 from the common-field constructors equals the A1 fixture (Appendix A)', () => {
    const p = encodePayload(
      { domainSep: D11, kind: 3 },
      commonRecords({ name: 'Acme Token', symbol: 'ACME', decimals: 6, standards: ['mip-0004'] }),
    );
    expect(toHex(p)).toBe(bin('A1'));
  });

  it('A2a/A2b: records that fill exactly 256 bytes', () => {
    expect(toHex(encodePayload({ domainSep: D11, kind: 3 }, [record.bytes(new Uint8Array(220).fill(0x6b), new Uint8Array(0))]))).toBe(
      bin('A2a'),
    );
    expect(
      toHex(
        encodePayload({ domainSep: D11, kind: 3 }, [
          record.bytes(
            'v',
            Uint8Array.from({ length: 219 }, (_, i) => i),
          ),
        ]),
      ),
    ).toBe(bin('A2b'));
  });

  it('A4b: decimals as Uint<128>', () => {
    expect(toHex(encodePayload({ domainSep: D11, kind: 3 }, [record.uint('decimals', 6, 16)]))).toBe(bin('A4b'));
  });

  it('throws PayloadTooLarge one byte over the limit', () => {
    expect(() => encodePayload({ domainSep: D11, kind: 3 }, [record.bytes('v', new Uint8Array(220))])).toThrow(PayloadTooLarge);
    try {
      encodePayload({ domainSep: D11, kind: 3 }, [record.bytes('v', new Uint8Array(220))]);
    } catch (e) {
      expect((e as PayloadTooLarge).size).toBe(257);
    }
  });

  it('throws InvalidHeader for a bad kind or domainSep', () => {
    for (const kind of [0, 4, 255])
      expect(() => encodePayload({ domainSep: D11, kind }, [record.utf8('name', 'x')])).toThrow(InvalidHeader);
    expect(() => encodePayload({ domainSep: new Uint8Array(31), kind: 3 }, [record.utf8('name', 'x')])).toThrow(InvalidHeader);
  });

  it('throws InvalidRecord for every value a consumer would reject', () => {
    const bad = [
      { key: new Uint8Array(0), valType: 1, value: new Uint8Array(0) },
      { key: new Uint8Array(256), valType: 0, value: new Uint8Array(0) },
      { key: Uint8Array.of(0x6b), valType: 6, value: new Uint8Array(0) },
      { key: Uint8Array.of(0x6b), valType: 1, value: Uint8Array.of(0xff) },
      { key: Uint8Array.of(0x6b), valType: 2, value: new Uint8Array(0) },
      { key: Uint8Array.of(0x6b), valType: 2, value: new Uint8Array(32) },
      { key: Uint8Array.of(0x6b), valType: 3, value: new TextEncoder().encode('{') },
      { key: Uint8Array.of(0x6b), valType: 4, value: new TextEncoder().encode('/relative') },
      { key: Uint8Array.of(0x6b), valType: 5, value: Uint8Array.of(0) },
    ];
    for (const r of bad) expect(() => encodePayload({ domainSep: D11, kind: 3 }, [r])).toThrow(InvalidRecord);
    expect(() => encodePayload({ domainSep: D11, kind: 3 }, [])).toThrow(InvalidRecord);
  });

  it('withdrawRecords() is the four Null records name, symbol, decimals, standards (39 bytes; MIP "Applying records")', () => {
    const recs = withdrawRecords();
    expect(recs.map((r) => [new TextDecoder().decode(r.key), r.valType, r.value.length])).toEqual([
      ['name', 5, 0],
      ['symbol', 5, 0],
      ['decimals', 5, 0],
      ['standards', 5, 0],
    ]);
    expect(recordsSize(recs)).toBe(39);
    const p = encodePayload({ domainSep: D11, kind: 1 }, recs);
    expect(toHex(p.subarray(33, 72))).toBe('046e616d6505000673796d626f6c050008646563696d616c73050009' + '7374616e64617264730500');
    expect(p.subarray(72).every((b) => b === 0)).toBe(true);
  });

  it('refuses a URI with characters outside ASCII; its percent-encoded and ASCII-host forms are emitted (MIP valType 4)', () => {
    for (const raw of ['https://ä.example/logo.png', 'https://acme.example/ä.png', 'https://acme.example/?q=ä'])
      expect(() => encodePayload({ domainSep: D11, kind: 3 }, [record.uri('logo', raw)])).toThrow(InvalidRecord);
    for (const ascii of ['https://xn--4ca.example/logo.png', 'https://acme.example/%C3%A4.png', 'https://acme.example/?q=%C3%A4'])
      expect(encodePayload({ domainSep: D11, kind: 3 }, [record.uri('logo', ascii)])).toHaveLength(256);
  });

  it('record constructors produce the MIP value types', () => {
    expect(record.tombstone('name').valType).toBe(5);
    expect(record.tombstone('name').value).toHaveLength(0);
    expect(record.json('meta', 'null').valType).toBe(3);
    expect(record.uri('logo', 'https://acme.example/logo.png').valType).toBe(4);
    expect([...record.uint('decimals', 18).value]).toEqual([18]);
  });
});
