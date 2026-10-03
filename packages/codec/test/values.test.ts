// Value-type rules: strict UTF-8, platform JSON, integers 1-31 bytes little-endian, Null, reserved types.
import { describe, expect, it } from 'vitest';
import { checkValue, decodeUint, decodeUtf8, encodeUint, minimalUintWidth } from '../src/index.ts';

const b = (...xs: number[]) => Uint8Array.from(xs);
const t = (s: string) => new TextEncoder().encode(s);

describe('UTF-8 (types 1, 3, 4)', () => {
  it.each([
    ['lone continuation byte', b(0x80)],
    ['invalid lead byte ff', b(0xff)],
    ['truncated 2-byte sequence', b(0xc3)],
    ['overlong "/" (c0 af)', b(0xc0, 0xaf)],
    ['overlong 3-byte NUL (e0 80 80)', b(0xe0, 0x80, 0x80)],
    ['UTF-16 surrogate U+D800 (ed a0 80)', b(0xed, 0xa0, 0x80)],
    ['above U+10FFFF (f4 90 80 80)', b(0xf4, 0x90, 0x80, 0x80)],
  ])('rejects %s', (_, bytes) => {
    expect(decodeUtf8(bytes)).toBeUndefined();
    expect(checkValue(1, bytes)).toBe('invalid-utf8');
    expect(checkValue(3, bytes)).toBe('invalid-utf8');
    expect(checkValue(4, bytes)).toBe('invalid-utf8');
  });
  it('accepts the empty string, NUL, noncharacters and astral characters', () => {
    for (const v of [b(), b(0), t('\uFFFF'), t('😀'), t('Acme Token')]) expect(checkValue(1, v)).toBeUndefined();
  });
  it('keeps a leading BOM as a character (bytes are never altered)', () => {
    expect(decodeUtf8(b(0xef, 0xbb, 0xbf, 0x41))).toBe('\uFEFFA');
  });
});

describe('JSON (type 3) — the platform parser on the decoded text', () => {
  it.each(['null', 'true', '0', '-1.5e3', '"x"', '[]', '{"a":[1,{"b":null}]}', ' {} ', '"\\ud800"'])('accepts %s', (s) => {
    expect(checkValue(3, t(s))).toBeUndefined();
  });
  it.each(['', ' ', '{', '{"name":"Acme"', '1 2', "{'a':1}", '{"a":1,}', 'NaN', 'undefined', '\uFEFF{}'])('rejects %j', (s) => {
    expect(checkValue(3, t(s))).toBe('invalid-json');
  });
  it('handles maximum nesting within 219 bytes without throwing', () => {
    expect(checkValue(3, t('['.repeat(109) + ']'.repeat(109)))).toBeUndefined();
    expect(checkValue(3, t('['.repeat(219)))).toBe('invalid-json');
  });
});

describe('unsigned integers (type 2)', () => {
  it('accepts 1-31 bytes and rejects 0 and 32', () => {
    expect(checkValue(2, new Uint8Array(0))).toBe('bad-integer-length');
    expect(checkValue(2, new Uint8Array(1))).toBeUndefined();
    expect(checkValue(2, new Uint8Array(31))).toBeUndefined();
    expect(checkValue(2, new Uint8Array(32))).toBe('bad-integer-length');
  });
  it('decodes little-endian at every width (A4)', () => {
    for (let w = 1; w <= 31; w++) {
      const v = new Uint8Array(w);
      v[0] = 6;
      expect(decodeUint(v)).toBe(6n);
    }
    const max = new Uint8Array(31).fill(0xff);
    expect(decodeUint(max)).toBe(2n ** 248n - 1n);
    expect(decodeUint(b(0x01, 0x02))).toBe(0x0201n);
  });
  it('encodes with an explicit or minimal width', () => {
    expect([...encodeUint(6, 1)]).toEqual([6]);
    expect([...encodeUint(6n, 16)]).toEqual([6, ...new Array(15).fill(0)]);
    expect(minimalUintWidth(0)).toBe(1);
    expect(minimalUintWidth(256)).toBe(2);
    expect(() => encodeUint(256, 1)).toThrow(RangeError);
    expect(() => encodeUint(1, 0)).toThrow(RangeError);
    expect(() => encodeUint(1, 32)).toThrow(RangeError);
    expect(() => encodeUint(-1, 1)).toThrow(RangeError);
  });
});

describe('Null (type 5), bytes (type 0) and reserved types', () => {
  it('Null must be empty', () => {
    expect(checkValue(5, b())).toBeUndefined();
    expect(checkValue(5, b(0))).toBe('bad-null-length');
  });
  it('bytes accept anything', () => {
    expect(checkValue(0, b())).toBeUndefined();
    expect(checkValue(0, new Uint8Array(219).fill(0xff))).toBeUndefined();
  });
  it('6-255 are reserved', () => {
    for (let v = 6; v <= 255; v++) expect(checkValue(v, b())).toBe('reserved-valtype');
  });
});
