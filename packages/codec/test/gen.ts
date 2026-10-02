// Payload generators for the fuzz and round-trip tests.
import { encodeUint, record, type MetadataRecord } from '../src/index.ts';
import type { Rng } from './prng.ts';

const te = new TextEncoder();
export const JSON_SAMPLES = ['null', 'true', '0', '-1.5e3', '"Acme"', '[]', '{}', '{"a":[1,{"b":null}]}', ' {"x":1} ', '"\\u00e9"'];
export const BAD_JSON = ['{', '{"a":1,}', '1 2', 'NaN', "{'a':1}", ''];
export const URI_SAMPLES = [
  'https://acme.example/logo.png',
  'ipfs://bafy',
  'urn:isbn:0451450523',
  'x:',
  'https://acme.example/a#v2',
  'data:,hi',
  'mailto:a@b.example',
];
export const BAD_URIS = [
  '/relative',
  '//net/path',
  'https://ä.example/',
  'https://a b/',
  ' https://a.example/',
  'https://a.example/%zz',
  '',
];

export function asciiText(r: Rng, max: number): Uint8Array {
  const n = r.int(max + 1);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = 0x20 + r.int(95);
  return out;
}

export function asciiExact(r: Rng, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = 0x21 + r.int(94);
  return out;
}

/** A value for `valType`, valid with probability `pValid`. */
export function valueFor(r: Rng, valType: number, pValid: number): Uint8Array {
  const valid = r.chance(pValid);
  switch (valType) {
    case 0:
      return r.bytes(r.int(40));
    case 1:
      return valid ? (r.chance(0.2) ? te.encode(r.pick(['é', 'Ω', '😀', ''])) : asciiText(r, 30)) : r.bytes(1 + r.int(20));
    case 2:
      return valid ? r.bytes(1 + r.int(31)) : r.bytes(r.chance(0.5) ? 0 : 32 + r.int(10));
    case 3:
      return te.encode(valid ? r.pick(JSON_SAMPLES) : r.pick(BAD_JSON));
    case 4:
      return te.encode(valid ? r.pick(URI_SAMPLES) : r.pick(BAD_URIS));
    case 5:
      return valid ? new Uint8Array(0) : r.bytes(1 + r.int(3));
    default:
      return r.bytes(r.int(8));
  }
}

/** Random-but-structured payload: plausible header and records, sometimes broken (lengths, types, padding). */
export function structuredPayload(r: Rng): Uint8Array {
  const p = new Uint8Array(256);
  p.set(r.bytes(32), 0);
  p[32] = r.chance(0.9) ? 1 + r.int(3) : r.byte();
  let at = 33;
  const n = 1 + r.int(6);
  for (let k = 0; k < n && at < 256; k++) {
    const keyLen = r.chance(0.95) ? 1 + r.int(12) : 1 + r.int(255);
    const valType = r.chance(0.9) ? r.int(6) : r.byte();
    const value = valueFor(r, valType, 0.85);
    const valLen = r.chance(0.97) ? value.length : r.byte();
    const key = r.chance(0.7) ? asciiExact(r, keyLen) : r.bytes(keyLen);
    const bytes = [keyLen, ...key, valType, valLen, ...value];
    for (const x of bytes) {
      if (at >= 256) break;
      p[at++] = x & 0xff;
    }
  }
  if (r.chance(0.05)) p[at + r.int(Math.max(1, 256 - at))] = 1 + r.int(255); // stray byte in the padding (may be past 255: ignored)
  return p;
}

/** A random list of valid records that fits in one payload. */
export function validRecords(r: Rng): MetadataRecord[] {
  const out: MetadataRecord[] = [];
  let size = 33;
  const n = 1 + r.int(8);
  for (let i = 0; i < n; i++) {
    const t = r.int(6);
    const key = r.chance(0.8) ? asciiText(r, 12) : r.bytes(1 + r.int(12));
    const k = key.length === 0 ? Uint8Array.of(0x6b) : key;
    let rec: MetadataRecord;
    if (t === 2) rec = { key: k, valType: 2, value: encodeUint(BigInt(r.u32()), 4 + r.int(10)) };
    else if (t === 5) rec = record.tombstone(k);
    else rec = { key: k, valType: t, value: valueFor(r, t, 1) };
    if (size + 3 + rec.key.length + rec.value.length > 256) break;
    size += 3 + rec.key.length + rec.value.length;
    out.push(rec);
  }
  if (out.length === 0) out.push(record.utf8('name', 'x'));
  return out;
}
