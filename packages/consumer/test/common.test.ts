// `standards` list format and amount display.
import { describe, expect, it } from 'vitest';
import { formatAmount, parseStandards } from '../src/index.ts';

const t = (s: string) => new TextEncoder().encode(s);

describe('parseStandards', () => {
  it.each([
    ['', []],
    ['mip-0004', ['mip-0004']],
    ['mip-0004 mip-0011 erc-20', ['mip-0004', 'mip-0011', 'erc-20']],
    ['mip-0004 mip-0004', ['mip-0004', 'mip-0004']],
    ['mip-0004 x y', ['mip-0004', 'x y']],
    ['ünïcode', ['ünïcode']],
  ])('%j → %j', (s, ids) => expect(parseStandards(t(s))).toEqual(ids));
  it.each(['mip-0004  mip-0011', ' mip-0004', 'mip-0004 ', ' ', 'a\tb', 'a\nb', 'a\u007fb', 'a\u0000b'])('%j is malformed', (s) => {
    expect(parseStandards(t(s))).toBeUndefined();
  });
});

describe('formatAmount', () => {
  it.each([
    [123456n, 2n, '1234.56'],
    [1234567n, 6n, '1.234567'],
    [123456n, 0n, '123456'],
    [5n, 8n, '0.00000005'],
    [0n, 6n, '0'],
    [123400n, 2n, '1234'],
    [100n, 2n, '1'],
    [10n ** 30n, 18n, '1000000000000'],
    [-1050n, 2n, '-10.5'],
  ])('(%s, %s) → %s', (raw, d, text) => expect(formatAmount(raw, d)).toBe(text));
  it('keeps trailing zeros on request', () => {
    expect(formatAmount(123400n, 2n, { trimTrailingZeros: false })).toBe('1234.00');
  });
  it('renders any decimals exactly and quickly (no cap)', () => {
    const huge = 2n ** 248n - 1n;
    const t0 = performance.now();
    expect(formatAmount(123456n, huge)).toBe(`1.23456e-${(huge - 5n).toString()}`);
    expect(formatAmount(1n, 10n ** 30n)).toBe('1e-1000000000000000000000000000000');
    expect(formatAmount(0n, huge)).toBe('0');
    expect(formatAmount(7n, 1000n)).toBe(`0.${'0'.repeat(999)}7`);
    expect(formatAmount(7n, 1001n)).toBe('7e-1001');
    expect(performance.now() - t0).toBeLessThan(50);
  });
  it('rejects negative decimals', () => {
    expect(() => formatAmount(1n, -1n)).toThrow(RangeError);
  });
});
