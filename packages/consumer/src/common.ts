// Common fields (MIP "Common fields"): usability of `name`, `symbol`, `decimals`, `standards`, `image` and
// `image_sha256`; the served (truncated) `name`/`symbol`; the `standards` list format; the image content check; amount
// display. Keys (MIP "Keys"): the keys a consumer serves — the common keys and the keys of standards the token
// declares.
import { createHash } from 'node:crypto';
import { decodeUtf8, IMAGE_SHA256_SIZE, NAME_MAX_CHARS, SYMBOL_MAX_CHARS, toHex, ValType } from '@mip0018/codec';
import { ALL_CONSUMER_RULES, type ConsumerRules } from './rules.ts';

const enc = new TextEncoder();
export const KEY_NAME = toHex(enc.encode('name'));
export const KEY_SYMBOL = toHex(enc.encode('symbol'));
export const KEY_DECIMALS = toHex(enc.encode('decimals'));
export const KEY_STANDARDS = toHex(enc.encode('standards'));
export const KEY_IMAGE = toHex(enc.encode('image'));
export const KEY_IMAGE_SHA256 = toHex(enc.encode('image_sha256'));
/** The six keys of MIP "Common fields" (hex): always served. */
export const COMMON_KEYS: ReadonlySet<string> = new Set([KEY_NAME, KEY_SYMBOL, KEY_DECIMALS, KEY_STANDARDS, KEY_IMAGE, KEY_IMAGE_SHA256]);

/** A key a standard defines, with its value type (MIP "Keys": a key has meaning only when a MIP defines it). */
export interface KeyDefinition {
  key: string;
  valType: number;
}

/**
 * Key definitions per standard identifier, e.g. `{ "mip-00xx": [{ key: "k", valType: 1 }] }`. The keys a standard
 * defines are served only while a token's current, usable `standards` lists that identifier. Empty by default: no MIP
 * defines keys beyond the common fields yet.
 */
export type DefinedKeys = Readonly<Record<string, readonly KeyDefinition[]>>;

/**
 * The keys served for a token whose current usable `standards` lists `declared`: the common keys plus every key the
 * declared standards define (hex → the value types those definitions allow).
 */
export function servedKeys(declared: readonly string[], definedKeys: DefinedKeys): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const id of declared) {
    const defs = Object.hasOwn(definedKeys, id) ? definedKeys[id] : undefined;
    for (const d of defs ?? []) {
      const k = toHex(enc.encode(d.key));
      if (COMMON_KEYS.has(k)) continue;
      const types = out.get(k) ?? new Set<number>();
      types.add(d.valType);
      out.set(k, types);
    }
  }
  return out;
}

/** The first `max` Unicode code points of a UTF-8 value, and whether anything was cut. Invalid UTF-8 is returned as is. */
export function truncateCodePoints(value: Uint8Array, max: number): { value: Uint8Array; truncated: boolean } {
  const text = decodeUtf8(value);
  if (text === undefined) return { value, truncated: false };
  const cps = Array.from(text);
  if (cps.length <= max) return { value, truncated: false };
  return { value: enc.encode(cps.slice(0, max).join('')), truncated: true };
}

/**
 * The value a consumer serves and displays for a field: a usable `name` or `symbol` longer than 64 / 12 characters is
 * truncated to its first 64 / 12 Unicode code points (MIP "Common fields": "consumers SHOULD discard any extra
 * characters"); every other value is served as stored. The stored bytes never change, and grouping compares them.
 */
export function servedValue(keyHex: string, valType: number, value: Uint8Array, rules: ConsumerRules = ALL_CONSUMER_RULES): Uint8Array {
  if (!rules.truncateLength || valType !== ValType.Utf8) return value;
  if (keyHex === KEY_NAME) return truncateCodePoints(value, NAME_MAX_CHARS).value;
  if (keyHex === KEY_SYMBOL) return truncateCodePoints(value, SYMBOL_MAX_CHARS).value;
  return value;
}

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
 * are not common fields (the MIP gives them no usability rule). A `name` or `symbol` over its maximum length is still
 * usable; it is served truncated (`servedValue`).
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
    case KEY_IMAGE:
      return rules.imageForm ? valType === ValType.Uri : true;
    case KEY_IMAGE_SHA256:
      return rules.imageForm ? valType === ValType.Bytes && value.length === IMAGE_SHA256_SIZE : true;
    default:
      return undefined;
  }
}

/** SHA-256 of `content`. */
export function sha256(content: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(content).digest());
}

/**
 * Whether content fetched from `image` may be displayed (MIP "Common fields": "When `image_sha256` is set, consumers
 * MUST NOT display content from `image` whose SHA-256 differs from it"). `imageSha256` is the token's current
 * `image_sha256` value as stored, or `undefined` when the field has no value:
 *
 * - no `image_sha256`: `true` — the content cannot be checked, and the caller decides (MIP "Off-chain content");
 * - `image_sha256` set: `true` only when it equals the content's SHA-256. A value that is not 32 bytes (unusable)
 *   equals no SHA-256, so no content is displayed for it.
 *
 * The reference tools never fetch `image`; this check is for consumers that do. Images are untrusted content and
 * SHOULD be rendered in a way that cannot run scripts (not as inline SVG; MIP "Security Considerations").
 */
export function imageContentAllowed(
  imageSha256: Uint8Array | undefined,
  content: Uint8Array,
  rules: ConsumerRules = ALL_CONSUMER_RULES,
): boolean {
  if (imageSha256 === undefined || !rules.imageHash) return true;
  const digest = sha256(content);
  return imageSha256.length === digest.length && digest.every((b, i) => b === imageSha256[i]);
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
 * arithmetic for any `decimals` (no cap: the MIP sets none). Examples: (123456, 2) → "1234.56"; (5, 8) → "0.00000005";
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
