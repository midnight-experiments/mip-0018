// SPDX-License-Identifier: Apache-2.0
//
// JSON → Compact runtime values for `--args`.
//
// Circuit arguments are converted WITH their types, read from the compiler's `compiler/contract-info.json`
// (`circuits[].arguments[].type`), so a wrong size or range is refused before anything is proved:
//
//   Bytes<N>     "0x…" / hex of exactly N bytes, or {"$utf8": "text"}: UTF-8 of EXACTLY N bytes — shorter text is
//                refused, because zero padding becomes part of a MIP-0018 value ("SPS" in Bytes<4> is "SPS\0");
//                {"$utf8": "text", "pad": true} zero-pads on purpose (e.g. a pad(32, "…") domain separator)
//   Uint<…>      number, decimal string or {"$bigint": "…"} → bigint (0 ≤ v ≤ maxval)
//   Field        same as Uint (no range check beyond ≥ 0)
//   Boolean      true / false
//   Struct       an object with exactly the struct's element names
//   Vector<N,T>  an array of N values of T
//   Tuple        an array, one value per element type
//   Opaque       "string": a JSON string; "Uint8Array": hex
//   Enum         the member index (number)
//
// Constructor arguments have no machine-readable types in the compiler output, so they use a typed-JSON
// convention: "0x…" → bytes, {"$utf8": "text", "pad": N} → UTF-8 bytes zero-padded to N, numbers and
// {"$bigint"} → bigint, {"$string": "…"} → string (escape), other strings → string, booleans, arrays and objects
// recursively.
//
// Placeholders (resolved FIRST, for constructor and circuit arguments alike, so one command line works for any
// signer — e.g. "mint to myself"): an object with exactly one of these keys is replaced by a JSON value:
//
//   {"$signer": "coinPublicKey"}       the signer wallet's shielded coin public key ("0x…", 32 bytes)
//   {"$signer": "unshieldedAddress"}   the signer wallet's unshielded user address ("0x…", 32 bytes)
//   {"$random": N}                     N fresh random bytes ("0x…"; e.g. a shielded mint's nonce), 1 ≤ N ≤ 1024
//   {"$adapter": "<name>"}             a value the contract adapter offers (e.g. the owner's account id)
//
// The run record keeps the arguments AS GIVEN (with the placeholders): the step id stays the same on a re-run.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ArgsError extends Error {
  override name = 'ArgsError';
}

/** What placeholders resolve against. */
export interface PlaceholderContext {
  /** Shielded coin public key of the signer (hex, no 0x). */
  coinPublicKey?: string;
  /** Unshielded user address of the signer (hex, no 0x). */
  unshieldedAddress?: string;
  /** Named JSON values the adapter offers (`{"$adapter": name}`). */
  adapter?: Record<string, unknown>;
  /** Random source (tests). */
  random?: (n: number) => Uint8Array;
}

const PLACEHOLDER_KEYS = ['$signer', '$random', '$adapter'] as const;

/** Whether a JSON value contains a placeholder anywhere. */
export function hasPlaceholders(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasPlaceholders);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && (PLACEHOLDER_KEYS as readonly string[]).includes(keys[0]!)) return true;
    return Object.values(v).some(hasPlaceholders);
  }
  return false;
}

/** Replaces every placeholder in a JSON value (see the header). Unknown names are refused. */
export function resolvePlaceholders(v: unknown, ctx: PlaceholderContext): unknown {
  if (Array.isArray(v)) return v.map((x) => resolvePlaceholders(x, ctx));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === '$signer') {
    const what = o.$signer;
    const hex = what === 'coinPublicKey' ? ctx.coinPublicKey : what === 'unshieldedAddress' ? ctx.unshieldedAddress : undefined;
    if (what !== 'coinPublicKey' && what !== 'unshieldedAddress')
      throw new ArgsError(`{"$signer": ${JSON.stringify(what)}}: one of "coinPublicKey", "unshieldedAddress"`);
    if (hex === undefined) throw new ArgsError(`{"$signer": "${what}"} is not available here (no wallet)`);
    return `0x${hex.replace(/^0x/u, '')}`;
  }
  if (keys.length === 1 && keys[0] === '$random') {
    const n = o.$random;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1024) throw new ArgsError('{"$random": N} needs 1 ≤ N ≤ 1024');
    return `0x${Buffer.from((ctx.random ?? ((k: number) => Uint8Array.from(randomBytes(k))))(n)).toString('hex')}`;
  }
  if (keys.length === 1 && keys[0] === '$adapter') {
    const name = String(o.$adapter);
    if (!ctx.adapter || !(name in ctx.adapter))
      throw new ArgsError(`{"$adapter": "${name}"}: the adapter offers ${Object.keys(ctx.adapter ?? {}).join(', ') || 'no values'}`);
    return ctx.adapter[name];
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolvePlaceholders(x, ctx)]));
}

export type CompactType =
  | { 'type-name': 'Bytes'; length: number }
  | { 'type-name': 'Uint'; maxval: number | string | bigint }
  | { 'type-name': 'Field' }
  | { 'type-name': 'Boolean' }
  | { 'type-name': 'Struct'; name: string; elements: { name: string; type: CompactType }[] }
  | { 'type-name': 'Vector'; length: number; type: CompactType }
  | { 'type-name': 'Tuple'; types: CompactType[] }
  | { 'type-name': 'Opaque'; tsType?: string; name?: string; 'opaque-type'?: string }
  | { 'type-name': 'Enum'; name: string; elements?: string[] }
  | { 'type-name': string; [k: string]: unknown };

export interface CircuitInfo {
  name: string;
  pure: boolean;
  proof: boolean;
  arguments: { name: string; type: CompactType }[];
}

/** Reads `compiler/contract-info.json`. Large integers (maxval) are kept exact by reading them as strings. */
export function contractInfo(managedDir: string): {
  circuits: CircuitInfo[];
  witnesses: { name: string }[];
  'compiler-version': string;
  'language-version': string;
} {
  const text = readFileSync(join(managedDir, 'compiler', 'contract-info.json'), 'utf8').replace(/("maxval":\s*)(\d+)/gu, '$1"$2"');
  return JSON.parse(text);
}

export function circuitInfo(managedDir: string, circuit: string): CircuitInfo {
  const c = contractInfo(managedDir).circuits.find((x) => x.name === circuit);
  if (!c) throw new ArgsError(`circuit ${circuit} is not in ${managedDir}/compiler/contract-info.json`);
  return c;
}

const hexBytes = (v: string, what: string): Uint8Array => {
  const h = v.startsWith('0x') ? v.slice(2) : v;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(h)) throw new ArgsError(`${what}: not hex`);
  return Uint8Array.from(Buffer.from(h, 'hex'));
};

const toBigint = (v: unknown, what: string): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/u.test(v)) return BigInt(v);
  if (v && typeof v === 'object' && typeof (v as { $bigint?: unknown }).$bigint === 'string')
    return BigInt((v as { $bigint: string }).$bigint);
  throw new ArgsError(`${what}: expected an unsigned integer`);
};

/** Converts one JSON value to the runtime value of a Compact type. */
export function fromJsonTyped(v: unknown, t: CompactType, what = 'argument'): unknown {
  switch (t['type-name']) {
    case 'Bytes': {
      const n = (t as { length: number }).length;
      if (v && typeof v === 'object' && typeof (v as { $utf8?: unknown }).$utf8 === 'string') {
        const text = (v as { $utf8: string }).$utf8;
        const b = new TextEncoder().encode(text);
        if (b.length > n) throw new ArgsError(`${what}: "${text}" is ${b.length} bytes, more than Bytes<${n}>`);
        if (b.length < n && (v as { pad?: unknown }).pad !== true)
          throw new ArgsError(
            `${what}: "${text}" is ${b.length} bytes, Bytes<${n}> needs exactly ${n} (zero padding would become part of the value; add "pad": true to pad on purpose)`,
          );
        const out = new Uint8Array(n);
        out.set(b);
        return out;
      }
      if (typeof v !== 'string') throw new ArgsError(`${what}: Bytes<${n}> expects hex or {"$utf8": …}`);
      const b = hexBytes(v, what);
      if (b.length !== n) throw new ArgsError(`${what}: Bytes<${n}> needs ${n} bytes, got ${b.length}`);
      return b;
    }
    case 'Uint': {
      const x = toBigint(v, what);
      const max = BigInt(String((t as { maxval: unknown }).maxval));
      if (x > max) throw new ArgsError(`${what}: ${x} exceeds the maximum ${max}`);
      return x;
    }
    case 'Field':
      return toBigint(v, what);
    case 'Boolean':
      if (typeof v !== 'boolean') throw new ArgsError(`${what}: expected true/false`);
      return v;
    case 'Struct': {
      const s = t as { name: string; elements: { name: string; type: CompactType }[] };
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ArgsError(`${what}: struct ${s.name} expects an object`);
      const o = v as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !s.elements.some((e) => e.name === k));
      if (extra.length) throw new ArgsError(`${what}: unknown field(s) ${extra.join(', ')} for struct ${s.name}`);
      return Object.fromEntries(
        s.elements.map((e) => {
          if (!(e.name in o)) throw new ArgsError(`${what}: missing field ${e.name} of struct ${s.name}`);
          return [e.name, fromJsonTyped(o[e.name], e.type, `${what}.${e.name}`)];
        }),
      );
    }
    case 'Vector': {
      const vt = t as { length: number; type: CompactType };
      if (!Array.isArray(v) || v.length !== vt.length)
        throw new ArgsError(`${what}: Vector<${vt.length}> expects an array of ${vt.length}`);
      return v.map((x, i) => fromJsonTyped(x, vt.type, `${what}[${i}]`));
    }
    case 'Tuple': {
      const tt = t as { types: CompactType[] };
      if (!Array.isArray(v) || v.length !== tt.types.length) throw new ArgsError(`${what}: tuple expects an array of ${tt.types.length}`);
      return v.map((x, i) => fromJsonTyped(x, tt.types[i]!, `${what}[${i}]`));
    }
    case 'Opaque': {
      const kind = String(
        (t as { tsType?: string; 'opaque-type'?: string; name?: string }).tsType ??
          (t as { 'opaque-type'?: string })['opaque-type'] ??
          (t as { name?: string }).name ??
          'string',
      );
      if (/Uint8Array/u.test(kind)) {
        if (typeof v !== 'string') throw new ArgsError(`${what}: Opaque<Uint8Array> expects hex`);
        return hexBytes(v, what);
      }
      if (typeof v !== 'string') throw new ArgsError(`${what}: Opaque<string> expects a string`);
      return v;
    }
    case 'Enum':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ArgsError(`${what}: enum expects a member index`);
      return v;
    default:
      throw new ArgsError(`${what}: unsupported Compact type ${t['type-name']}`);
  }
}

/** Converts a circuit's JSON argument list using the compiler's type information. */
export function circuitArgs(managedDir: string, circuit: string, json: unknown[]): unknown[] {
  const info = circuitInfo(managedDir, circuit);
  if (json.length !== info.arguments.length) {
    throw new ArgsError(
      `${circuit} takes ${info.arguments.length} argument(s) (${info.arguments.map((a) => a.name).join(', ') || 'none'}), got ${json.length}`,
    );
  }
  return info.arguments.map((a, i) => fromJsonTyped(json[i], a.type, `${circuit}(${a.name})`));
}

/** Typed-JSON convention for values without type information (constructor arguments). */
export function fromJsonLoose(v: unknown): unknown {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new ArgsError(`${v} is not a safe integer; pass {"$bigint": "…"}`);
    return BigInt(v);
  }
  if (typeof v === 'string') return /^0x([0-9a-fA-F]{2})*$/u.test(v) ? hexBytes(v, 'bytes') : v;
  if (Array.isArray(v)) return v.map(fromJsonLoose);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$bigint === 'string') return BigInt(o.$bigint);
    if (typeof o.$string === 'string') return o.$string;
    if (typeof o.$utf8 === 'string') {
      const b = new TextEncoder().encode(o.$utf8);
      const n = typeof o.pad === 'number' ? o.pad : b.length;
      if (b.length > n) throw new ArgsError(`"${o.$utf8}" does not fit in ${n} bytes`);
      const out = new Uint8Array(n);
      out.set(b);
      return out;
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromJsonLoose(x)]));
  }
  return v;
}
