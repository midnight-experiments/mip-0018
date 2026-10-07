// encodePayload: exact bytes for valid input; refuses anything a conforming consumer would reject.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR } from '@mip0018/vectors/common';
import { describe, expect, it } from 'vitest';
import {
  COMMON_KEY_TEXTS,
  commonRecords,
  decodePayload,
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
      // Keys MUST be valid UTF-8 (MIP "Keys"; vector R5i).
      { key: Uint8Array.of(0xff, 0x6b, 0x65, 0x79), valType: 1, value: new TextEncoder().encode('ok') },
      { key: Uint8Array.of(0xc0, 0xaf), valType: 0, value: new Uint8Array(0) },
    ];
    for (const r of bad) expect(() => encodePayload({ domainSep: D11, kind: 3 }, [r])).toThrow(InvalidRecord);
    expect(() => encodePayload({ domainSep: D11, kind: 3 }, [])).toThrow(InvalidRecord);
  });

  it('withdrawRecords() is the six Null records name, symbol, decimals, standards, image, image_sha256 (62 bytes; MIP "Applying records")', () => {
    const recs = withdrawRecords();
    expect(recs.map((r) => [new TextDecoder().decode(r.key), r.valType, r.value.length])).toEqual([
      ['name', 5, 0],
      ['symbol', 5, 0],
      ['decimals', 5, 0],
      ['standards', 5, 0],
      ['image', 5, 0],
      ['image_sha256', 5, 0],
    ]);
    expect(recs.map((r) => new TextDecoder().decode(r.key))).toEqual([...COMMON_KEY_TEXTS]);
    expect(recordsSize(recs)).toBe(62);
    const p = encodePayload({ domainSep: D11, kind: 1 }, recs);
    expect(toHex(p.subarray(33, 95))).toBe(
      '046e616d650500' +
        '0673796d626f6c0500' +
        '08646563696d616c730500' +
        '097374616e64617264730500' +
        '05696d6167650500' +
        '0c696d6167655f7368613235360500',
    );
    expect(p.subarray(95).every((b) => b === 0)).toBe(true);
    const d = decodePayload(p);
    expect(d.ok && d.contentEnd).toBe(95);
  });

  it('image and image_sha256 builders: a URI (type 4) and exactly 32 bytes (type 0); A6 from the builders equals the fixture', () => {
    const hash = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16));
    expect(record.image('https://example.org/acme.png')).toEqual({
      key: new TextEncoder().encode('image'),
      valType: 4,
      value: new TextEncoder().encode('https://example.org/acme.png'),
    });
    expect(record.imageSha256(hash).valType).toBe(0);
    expect(record.imageSha256(hash).value).toEqual(hash);
    for (const n of [0, 31, 33]) expect(() => record.imageSha256(new Uint8Array(n))).toThrow(RangeError);
    const viaCommon = commonRecords({ name: 'Acme', image: 'https://example.org/acme.png', imageSha256: hash });
    expect(viaCommon.map((r) => new TextDecoder().decode(r.key))).toEqual(['name', 'image', 'image_sha256']);
  });

  it('refuses a URI with characters outside ASCII; its percent-encoded and ASCII-host forms are emitted (MIP valType 4)', () => {
    for (const raw of ['https://ä.example/logo.png', 'https://acme.example/ä.png', 'https://acme.example/?q=ä'])
      expect(() => encodePayload({ domainSep: D11, kind: 3 }, [record.uri('logo', raw)])).toThrow(InvalidRecord);
    for (const ascii of ['https://xn--4ca.example/logo.png', 'https://acme.example/%C3%A4.png', 'https://acme.example/?q=%C3%A4'])
      expect(encodePayload({ domainSep: D11, kind: 3 }, [record.uri('logo', ascii)])).toHaveLength(256);
  });

  it('decodePayload rejects the whole event for a key that is not valid UTF-8 (R5i) and accepts multi-byte UTF-8 keys', () => {
    const bad = new Uint8Array(256);
    bad.set(D11, 0);
    bad[32] = 3;
    bad.set([0x04, 0xff, 0x6b, 0x65, 0x79, 0x01, 0x02, 0x6f, 0x6b], 33);
    expect(decodePayload(bad)).toEqual({ ok: false, reason: 'invalid-utf8-key', offset: 33 });
    // After a valid record, the invalid key still rejects the whole event (R6).
    const after = encodePayload({ domainSep: D11, kind: 3 }, [record.utf8('name', 'Acme')]);
    after.set([0x02, 0xc3, 0x28, 0x00, 0x00], 44);
    expect(decodePayload(after)).toEqual({ ok: false, reason: 'invalid-utf8-key', offset: 44 });
    for (const key of ['é', '名前', '😀', 'a\u0000b']) {
      const d = decodePayload(encodePayload({ domainSep: D11, kind: 3 }, [record.utf8(key, 'x')]));
      expect(d.ok && new TextDecoder().decode(d.records[0]!.key)).toBe(key);
    }
  });

  it('record constructors produce the MIP value types', () => {
    expect(record.tombstone('name').valType).toBe(5);
    expect(record.tombstone('name').value).toHaveLength(0);
    expect(record.json('meta', 'null').valType).toBe(3);
    expect(record.uri('logo', 'https://acme.example/logo.png').valType).toBe(4);
    expect([...record.uint('decimals', 18).value]).toEqual([18]);
  });
});
