// Common fields (MIP "Common fields"): usability of `name`, `symbol`, `decimals`, `standards`, the `standards` list
// format, and amount display.
import { decodeUtf8, toHex, ValType } from '@mip0018/codec';
import { ALL_CONSUMER_RULES, type ConsumerRules } from './rules.ts';

const enc = new TextEncoder();
export const KEY_NAME = toHex(enc.encode('name'));
export const KEY_SYMBOL = toHex(enc.encode('symbol'));
export const KEY_DECIMALS = toHex(enc.encode('decimals'));
export const KEY_STANDARDS = toHex(enc.encode('standards'));
export const COMMON_KEYS: ReadonlySet<string> = new Set([KEY_NAME, KEY_SYMBOL, KEY_DECIMALS, KEY_STANDARDS]);

/**
 * Parses a `standards` value: identifiers separated by single spaces (0x20); an identifier is non-empty and has no
 * byte in 0x00–0x20 or 0x7f. Returns the identifiers (possibly empty: no standards claimed), or `undefined` when the
 * value is malformed (unusable, not empty). The value must already be valid UTF-8 (a type-1 value).
 */
export function parseStandards(value: Uint8Array): string[] | undefined {
  if (value.length === 0) return [];
  const ids: string[] = [];
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const b = i < value.length ? (value[i] as number) : 0x20;
    if (b === 0x20) {
      if (i === start) return undefined; // empty identifier: leading, trailing or double space
      const text = decodeUtf8(value.subarray(start, i));
      if (text === undefined) return undefined;
      ids.push(text);
      start = i + 1;
    } else if (b < 0x20 || b === 0x7f) {
      return undefined;
    }
  }
  return ids;
}

/**
 * Whether the current value of a common field has the type and form the MIP requires. `undefined` for keys that
 * are not common fields (the MIP gives them no usability rule).
 */
export function commonFieldUsable(
  keyHex: string,
  valType: number,
  value: Uint8Array,
  rules: ConsumerRules = ALL_CONSUMER_RULES,
): boolean | undefined {
  switch (keyHex) {
    case KEY_NAME:
    case KEY_SYMBOL:
      return valType === ValType.Utf8 && (!rules.nonEmptyText || value.length > 0);
    case KEY_DECIMALS:
      return rules.decimalsType ? valType === ValType.UInt : true;
    case KEY_STANDARDS:
      return valType === ValType.Utf8 && (!rules.standardsFormat || parseStandards(value) !== undefined);
    default:
      return undefined;
  }
}

export interface FormatOptions {
  /**
   * Up to this many fractional digits the amount is written in plain positional notation; beyond it (only for
   * absurd `decimals` values) it is written exactly in scientific notation, so rendering never hangs. Default 1000.
   */
  maxPlainDigits?: number;
  /** Drop trailing zeros of the fraction (default true): 123400 with decimals 2 → "1234". */
  trimTrailingZeros?: boolean;
}

/**
 * Displays a raw amount as `amount / 10^decimals` (MIP "Common fields", vector S8), exactly, with `bigint`
 * arithmetic for any `decimals` (no cap; owner ruling F3). Examples: (123456, 2) → "1234.56"; (5, 8) → "0.00000005";
 * (123456, 0) → "123456"; (1, 10^30) → "1e-1000000000000000000000000000000".
 */
export function formatAmount(raw: bigint, decimals: bigint, opts: FormatOptions = {}): string {
  if (decimals < 0n) throw new RangeError('decimals must be unsigned');
  if (raw < 0n) return `-${formatAmount(-raw, decimals, opts)}`;
  const trim = opts.trimTrailingZeros ?? true;
  const maxPlain = BigInt(opts.maxPlainDigits ?? 1000);
  if (decimals === 0n) return raw.toString();
  if (decimals <= maxPlain) {
    const d = Number(decimals);
    const s = raw.toString().padStart(d + 1, '0');
    const int = s.slice(0, s.length - d);
    let frac = s.slice(s.length - d);
    if (trim) frac = frac.replace(/0+$/, '');
    return frac.length > 0 ? `${int}.${frac}` : int;
  }
  if (raw === 0n) return '0';
  // Exact scientific notation: digits d1.d2d3… × 10^(len − 1 − decimals).
  let digits = raw.toString();
  const exponent = BigInt(digits.length - 1) - decimals;
  digits = digits.replace(/0+$/, '');
  const mantissa = digits.length > 1 ? `${digits[0] as string}.${digits.slice(1)}` : digits;
  return `${mantissa}e${exponent.toString()}`;
}
