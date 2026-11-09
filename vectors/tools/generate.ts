#!/usr/bin/env node
/**
 * Independent generator for the MIP-0018 test vectors.
 *
 *   node vectors/tools/generate.ts           write every fixture, manifest.json and SHA256SUMS
 *   node vectors/tools/generate.ts --check   regenerate in memory and fail if anything differs from disk
 *
 * Independence: this file builds every payload by explicit byte arithmetic (offset by offset) and writes every
 * expected result by hand. It imports nothing from packages/codec or packages/consumer, and it contains no
 * decoder and no reducer: expected states below are literal tables, so the codec and the consumer are tested
 * against an oracle they did not produce. A1 is additionally checked against a literal transcription of the
 * MIP's Appendix A, and the 26 URI verdicts against the two independent grammars of the URI investigation.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cat, pad32, printable, repeat, sequence, toHex, utf8, type Bytes } from './bytes.ts';
import { FORMAT, listFiles, MANIFEST_FILE, MIP, PINNED_ROOTS, sha256Hex, SUMS_FILE, VECTORS_DIR } from './common.ts';

const GENERATOR = 'vectors/tools/generate.ts';

// ---------------------------------------------------------------------------------------------------------------
// Constants taken from the MIP text
// ---------------------------------------------------------------------------------------------------------------

/** `pad(32, "mip-0018:token-metadata[v1]")` — the MIP spells it out in the Event section. */
const NAME_V1 = pad32('mip-0018:token-metadata[v1]');
const NAME_V1_FROM_MIP = '6d69702d303031383a746f6b656e2d6d657461646174615b76315d' + '00'.repeat(5);
check(toHex(NAME_V1) === NAME_V1_FROM_MIP, 'event name differs from the MIP Event section');
const NAME_V2 = pad32('mip-0018:token-metadata[v2]');
const NAME_OTHER = pad32('acme:token-metadata[v1]');
/** The v1 text with a non-zero byte in its zero padding: a different 32-byte name. */
const NAME_V1_DIRTY = NAME_V1.slice();
NAME_V1_DIRTY[31] = 0x01;

const D11 = repeat(0x11, 32); // the MIP Testing default domainSep
const D22 = repeat(0x22, 32);
const D33 = repeat(0x33, 32);
const D44 = repeat(0x44, 32);
const D55 = repeat(0x55, 32);
const D66 = repeat(0x66, 32);
const D77 = repeat(0x77, 32);
const CONTRACT_A = 'aa'.repeat(32);
const CONTRACT_B = 'bb'.repeat(32);
const NET_A = 'testnet-a';
const NET_B = 'testnet-b';

const BYTES = 0;
const UTF8 = 1;
const UINT = 2;
const JSON_T = 3;
const URI = 4;
const NULL = 5;
const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------------------------------------------
// Payload construction by explicit byte arithmetic
// ---------------------------------------------------------------------------------------------------------------

interface Rec {
  key: Bytes;
  valType: number;
  value: Bytes;
  /** Expected decoded integer (valType 2), written by hand. */
  decoded?: string;
}

function asBytes(v: string | Bytes | number[]): Bytes {
  if (typeof v === 'string') return utf8(v);
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

function rec(key: string | Bytes | number[], valType: number, value: string | Bytes | number[], decoded?: string): Rec {
  const r: Rec = { key: asBytes(key), valType, value: asBytes(value) };
  if (decoded !== undefined) r.decoded = decoded;
  return r;
}

const R = {
  name: (s: string) => rec('name', UTF8, s),
  symbol: (s: string) => rec('symbol', UTF8, s),
  /** `decimals` as `Uint<8>` (one byte). */
  decimals: (n: number) => rec('decimals', UINT, [n], String(n)),
  standards: (s: string) => rec('standards', UTF8, s),
  image: (uri: string) => rec('image', URI, uri),
  imageSha256: (hash: Bytes) => rec('image_sha256', BYTES, hash),
  /** A Null record (tombstone): deletes the field at `key` (MIP "Applying records"). */
  tombstone: (key: string) => rec(key, NULL, EMPTY),
};

/** SHA-256 (node:crypto), for `image_sha256` values. */
function sha256(bytes: Bytes): Bytes {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}
/** The image content the S12 vectors check, and a substitute with another SHA-256. */
const IMAGE_URI = 'https://example.org/acme.png';
const IMAGE_CONTENT = utf8('MIP-0018 test image content: acme.png');
const IMAGE_OTHER = utf8('MIP-0018 test image content: substituted');
const IMAGE_SHA256 = sha256(IMAGE_CONTENT);

interface Built {
  bytes: Bytes;
  offsets: number[];
  contentEnd: number;
}

/** header ‖ records ‖ zero padding. Lengths are written as single bytes; nothing is validated except fit. */
function build(domainSep: Bytes, kind: number, recs: Rec[]): Built {
  check(domainSep.length === 32, 'domainSep must be 32 bytes');
  const p = new Uint8Array(256);
  p.set(domainSep, 0); // bytes 0..31
  p[32] = kind; // byte 32
  let at = 33;
  const offsets: number[] = [];
  for (const r of recs) {
    check(r.key.length >= 1 && r.key.length <= 255 && r.value.length <= 255, 'record lengths out of range');
    const size = 1 + r.key.length + 1 + 1 + r.value.length;
    check(at + size <= 256, `record at ${at} (${size} bytes) does not fit`);
    offsets.push(at);
    p[at] = r.key.length;
    p.set(r.key, at + 1);
    p[at + 1 + r.key.length] = r.valType;
    p[at + 2 + r.key.length] = r.value.length;
    p.set(r.value, at + 3 + r.key.length);
    at += size;
  }
  return { bytes: p, offsets, contentEnd: at };
}

/** A payload written byte range by byte range (for malformed payloads). */
function raw(domainSep: Bytes, kind: number, writes: Array<[number, Bytes | number[]]>): Bytes {
  const p = new Uint8Array(256);
  p.set(domainSep, 0);
  p[32] = kind;
  for (const [offset, bytes] of writes) {
    check(offset >= 33 && offset + bytes.length <= 256, `raw write at ${offset} does not fit`);
    p.set(bytes, offset);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Output collection
// ---------------------------------------------------------------------------------------------------------------

interface ManifestEntry {
  id: string;
  kind: 'payload' | 'state';
  file: string;
  bin?: string;
  testId: string;
  normative: boolean;
}

const outputs = new Map<string, Uint8Array>();
const manifest: ManifestEntry[] = [];
const ids = new Set<string>();

function emit(rel: string, data: Uint8Array | string): void {
  check(!outputs.has(rel), `duplicate output ${rel}`);
  outputs.set(rel, typeof data === 'string' ? utf8(data) : data);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function claimId(id: string): void {
  check(!ids.has(id), `duplicate vector id ${id}`);
  ids.add(id);
}

function textOf(bytes: Bytes): string | undefined {
  return printable(bytes);
}

function recordJson(r: Rec, offset: number): Record<string, unknown> {
  const o: Record<string, unknown> = { offset, key_hex: toHex(r.key) };
  const kt = textOf(r.key);
  if (kt !== undefined) o.key_text = kt;
  o.valType = r.valType;
  o.value_hex = toHex(r.value);
  if (r.valType === UTF8 || r.valType === JSON_T || r.valType === URI) {
    const vt = textOf(r.value);
    if (vt !== undefined) o.value_text = vt;
  }
  if (r.decoded !== undefined) o.decoded = r.decoded;
  return o;
}

interface PayloadDef {
  id: string;
  testId: string;
  normative?: boolean;
  description: string;
  basis?: string;
  type?: string;
  name?: Bytes;
  payload: Bytes;
  expect: Record<string, unknown>;
  dir?: string;
}

function payloadVector(d: PayloadDef): void {
  claimId(d.id);
  const dir = d.dir ?? 'payload';
  const normative = d.normative ?? true;
  // Normative vectors are the MIP's Testing items: full 32-byte name, 256-byte payload. Only the informative
  // zero-extension vectors give a name or payload as a source that dropped trailing zeros would (or a longer one).
  check(d.payload.length === 256 || (!normative && d.testId === 'INF-ZEXT'), `${d.id}: payload must be 256 bytes`);
  check((d.name ?? NAME_V1).length === 32 || (!normative && d.testId === 'INF-ZEXT'), `${d.id}: name must be 32 bytes`);
  const v: Record<string, unknown> = {
    id: d.id,
    mip: { commit: MIP.commit, testId: d.testId },
    normative,
    description: d.description,
  };
  if (d.basis !== undefined) v.basis = d.basis;
  v.event = {
    type: d.type ?? 'Misc',
    name_hex: toHex(d.name ?? NAME_V1),
    payload_hex: toHex(d.payload),
    payload_file: `${d.id}.bin`,
  };
  v.expect = d.expect;
  emit(`${dir}/${d.id}.json`, json(v));
  emit(`${dir}/${d.id}.bin`, d.payload);
  manifest.push({ id: d.id, kind: 'payload', file: `${dir}/${d.id}.json`, bin: `${dir}/${d.id}.bin`, testId: d.testId, normative });
}

interface AcceptDef {
  id: string;
  testId: string;
  normative?: boolean;
  description: string;
  basis?: string;
  domainSep?: Bytes;
  kind?: number;
  recs: Rec[];
  /** Hand-written offsets the construction must reproduce (from the MIP text where it states them). */
  offsets?: number[];
  contentEnd?: number;
  dir?: string;
}

function acceptVector(d: AcceptDef): Built {
  const domainSep = d.domainSep ?? D11;
  const kind = d.kind ?? 3;
  const b = build(domainSep, kind, d.recs);
  if (d.offsets !== undefined) check(b.offsets.join() === d.offsets.join(), `${d.id}: offsets ${b.offsets} != ${d.offsets}`);
  if (d.contentEnd !== undefined) check(b.contentEnd === d.contentEnd, `${d.id}: content end ${b.contentEnd} != ${d.contentEnd}`);
  const def: PayloadDef = {
    id: d.id,
    testId: d.testId,
    description: d.description,
    payload: b.bytes,
    expect: {
      result: 'accept',
      header: { domainSep: toHex(domainSep), kind },
      records: d.recs.map((r, i) => recordJson(r, b.offsets[i] as number)),
      contentEnd: b.contentEnd,
    },
  };
  if (d.normative !== undefined) def.normative = d.normative;
  if (d.basis !== undefined) def.basis = d.basis;
  if (d.dir !== undefined) def.dir = d.dir;
  payloadVector(def);
  return b;
}

function rejectVector(id: string, testId: string, description: string, payload: Bytes, reason: string, offset: number): void {
  payloadVector({ id, testId, description, payload, expect: { result: 'reject', reason, offset } });
}

function ignoreVector(id: string, description: string, ev: { type?: string; name: Bytes; payload: Bytes }, reason: string): void {
  const def: PayloadDef = { id, testId: 'IGNORE', description, name: ev.name, payload: ev.payload, expect: { result: 'ignore', reason } };
  if (ev.type !== undefined) def.type = ev.type;
  payloadVector(def);
}

// ----- state vectors -----

interface EvDef {
  network?: string;
  block: number;
  tx?: number;
  event?: number;
  contract?: string;
  domainSep?: Bytes;
  kind?: number;
  recs?: Rec[];
  /** A prebuilt payload (malformed events); overrides domainSep/kind/recs. */
  payload?: Bytes;
  name?: Bytes;
  type?: string;
  /** Hand-written offsets to assert. */
  offsets?: number[];
}

function apply(e: EvDef): Record<string, unknown> {
  let payload: Bytes;
  if (e.payload !== undefined) payload = e.payload;
  else {
    const b = build(e.domainSep ?? D11, e.kind ?? 3, e.recs ?? []);
    if (e.offsets !== undefined) check(b.offsets.join() === e.offsets.join(), `offsets ${b.offsets} != ${e.offsets}`);
    payload = b.bytes;
  }
  return {
    op: 'apply',
    network: e.network ?? NET_A,
    block: e.block,
    tx: e.tx ?? 0,
    event: e.event ?? 0,
    contractAddress: e.contract ?? CONTRACT_A,
    type: e.type ?? 'Misc',
    name_hex: toHex(e.name ?? NAME_V1),
    payload_hex: toHex(payload),
  };
}

function rollback(network: string, toBlock: number): Record<string, unknown> {
  return { op: 'rollback', network, toBlock };
}

interface FieldDef {
  key: Bytes;
  valType: number;
  value: Bytes;
  usable?: boolean;
}

function field(key: string | Bytes | number[], valType: number, value: string | Bytes | number[], usable?: boolean): FieldDef {
  const f: FieldDef = { key: asBytes(key), valType, value: asBytes(value) };
  if (usable !== undefined) f.usable = usable;
  return f;
}

/** Expected common fields; `usable` is always written explicitly by the vector author. */
const F = {
  name: (s: string, usable: boolean) => field('name', UTF8, s, usable),
  symbol: (s: string, usable: boolean) => field('symbol', UTF8, s, usable),
  decimals: (n: number, usable: boolean) => field('decimals', UINT, [n], usable),
  standards: (s: string, usable: boolean) => field('standards', UTF8, s, usable),
};

interface IdDef {
  network?: string;
  contract?: string;
  domainSep?: Bytes;
  kind: number;
  /**
   * The identity's current fields — at least one: an identity whose last field was deleted is not referenced at all
   * (MIP "Applying records"), so an expectation simply leaves it out.
   */
  fields: FieldDef[];
  colored?: boolean;
}

function identity(d: IdDef): Record<string, unknown> {
  check(d.fields.length > 0, 'an expected identity has at least one field (an identity without fields is not referenced)');
  const fields: Record<string, unknown> = {};
  for (const f of d.fields) {
    const k = toHex(f.key);
    check(!(k in fields), `duplicate expected field ${k}`);
    const o: Record<string, unknown> = {};
    const kt = textOf(f.key);
    if (kt !== undefined) o.key_text = kt;
    o.valType = f.valType;
    o.value_hex = toHex(f.value);
    if (f.valType === UTF8 || f.valType === JSON_T || f.valType === URI) {
      const vt = textOf(f.value);
      if (vt !== undefined) o.value_text = vt;
    }
    if (f.usable !== undefined) o.usable = f.usable;
    fields[k] = o;
  }
  const o: Record<string, unknown> = {
    network: d.network ?? NET_A,
    contractAddress: d.contract ?? CONTRACT_A,
    domainSep: toHex(d.domainSep ?? D11),
    kind: d.kind,
  };
  if (d.colored !== undefined) o.colored = d.colored;
  o.fields = fields;
  return o;
}

function group(network: string, contract: string, symbol: string, members: Array<[Bytes, number]>): Record<string, unknown> {
  return {
    network,
    contractAddress: contract,
    symbol_hex: toHex(utf8(symbol)),
    symbol_text: symbol,
    members: members.map(([d, kind]) => ({ domainSep: toHex(d), kind })),
  };
}

interface DisplayDef {
  network?: string;
  contract?: string;
  domainSep?: Bytes;
  kind: number;
  raw: string;
  decimals: string;
  text: string;
}

function display(d: DisplayDef): Record<string, unknown> {
  return {
    network: d.network ?? NET_A,
    contractAddress: d.contract ?? CONTRACT_A,
    domainSep: toHex(d.domainSep ?? D11),
    kind: d.kind,
    raw: d.raw,
    decimals: d.decimals,
    text: d.text,
  };
}

interface ImageDef {
  network?: string;
  contract?: string;
  domainSep?: Bytes;
  kind: number;
  content: Bytes;
  /** Whether content with these bytes, fetched from the identity's `image`, may be displayed. */
  displayable: boolean;
}

function image(d: ImageDef): Record<string, unknown> {
  return {
    network: d.network ?? NET_A,
    contractAddress: d.contract ?? CONTRACT_A,
    domainSep: toHex(d.domainSep ?? D11),
    kind: d.kind,
    content_hex: toHex(d.content),
    displayable: d.displayable,
  };
}

interface StateDef {
  id: string;
  testId: string;
  normative?: boolean;
  description: string;
  basis?: string;
  steps: Array<Record<string, unknown>>;
  identities: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  display?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
  /** Keys that (test) standards define, loaded by the consumer before the steps (MIP "Keys"). */
  definedKeys?: Record<string, Array<{ key: string; valType: number }>>;
  dir?: string;
}

function stateVector(d: StateDef): void {
  claimId(d.id);
  const dir = d.dir ?? 'state';
  const normative = d.normative ?? true;
  const v: Record<string, unknown> = { id: d.id, mip: { commit: MIP.commit, testId: d.testId }, normative, description: d.description };
  if (d.basis !== undefined) v.basis = d.basis;
  if (d.definedKeys !== undefined) v.definedKeys = d.definedKeys;
  v.steps = d.steps;
  const expect: Record<string, unknown> = { identities: d.identities };
  if (d.groups !== undefined) expect.groups = d.groups;
  if (d.display !== undefined) expect.display = d.display;
  if (d.images !== undefined) expect.images = d.images;
  v.expect = expect;
  emit(`${dir}/${d.id}.json`, json(v));
  manifest.push({ id: d.id, kind: 'state', file: `${dir}/${d.id}.json`, testId: d.testId, normative });
}

// ===============================================================================================================
// Normative payload vectors — "Must accept"
// ===============================================================================================================

const A1_RECS = [R.name('Acme Token'), R.symbol('ACME'), R.decimals(6), R.standards('mip-0004')];
const A1 = acceptVector({
  id: 'A1',
  testId: 'A1',
  description:
    'Common fields and standards: name "Acme Token", symbol "ACME", decimals 6 as Uint<8>, standards "mip-0004" (domainSep 0x11 x 32, kind 3). Records at offsets 33, 50, 63, 75; content ends at 95; 161 zero bytes follow. Bytes equal MIP Appendix A.',
  recs: A1_RECS,
  offsets: [33, 50, 63, 75],
  contentEnd: 95,
});

/** MIP Appendix A, transcribed line by line: [offset, bytes]. */
const APPENDIX_A: Array<[number, string]> = [
  [0, '11'.repeat(32)],
  [32, '03'],
  [33, '04' + '6e616d65' + '01' + '0a' + '41636d6520546f6b656e'],
  [50, '06' + '73796d626f6c' + '01' + '04' + '41434d45'],
  [63, '08' + '646563696d616c73' + '02' + '01' + '06'],
  [75, '09' + '7374616e6461726473' + '01' + '08' + '6d69702d30303034'],
  [95, '00'.repeat(161)],
];
{
  let at = 0;
  for (const [offset, hex] of APPENDIX_A) {
    check(offset === at, `Appendix A line at ${offset} is not contiguous`);
    check(toHex(A1.bytes.subarray(offset, offset + hex.length / 2)) === hex, `A1 differs from Appendix A at offset ${offset}`);
    at += hex.length / 2;
  }
  check(at === 256, 'Appendix A does not cover 256 bytes');
}

acceptVector({
  id: 'A2a',
  testId: 'A2',
  description: 'Capacity: one type-0 record with a 220-byte key (220 x "k") and an empty value fills exactly 256 bytes; no padding.',
  recs: [rec(repeat(0x6b, 220), BYTES, EMPTY)],
  offsets: [33],
  contentEnd: 256,
});
acceptVector({
  id: 'A2b',
  testId: 'A2',
  description:
    'Capacity: one type-0 record with a 1-byte key "v" and a 219-byte value (bytes 00 01 … da, starting with a zero byte) fills exactly 256 bytes; no padding.',
  recs: [rec('v', BYTES, sequence(219, 0))],
  offsets: [33],
  contentEnd: 256,
});
acceptVector({
  id: 'A3a',
  testId: 'A3',
  description: 'Exact bytes: "symbol" = "ACME" and "symbol" followed by 0x00 = "ZZZ" are two different keys (two records, two fields).',
  recs: [R.symbol('ACME'), rec(cat(utf8('symbol'), [0x00]), UTF8, 'ZZZ')],
  offsets: [33, 46],
});
acceptVector({
  id: 'A3b',
  testId: 'A3',
  description: 'Exact bytes: the type-0 value 01 00 00 keeps its trailing zeros (value length 3).',
  recs: [rec('data', BYTES, [0x01, 0x00, 0x00])],
  contentEnd: 43,
});
acceptVector({
  id: 'A4a',
  testId: 'A4',
  description: 'Integer widths: decimals as 06 (Uint<8>) decodes to 6.',
  recs: [rec('decimals', UINT, [0x06], '6')],
});
acceptVector({
  id: 'A4b',
  testId: 'A4',
  description: 'Integer widths: decimals as 06 followed by 15 zero bytes (Uint<128>, little-endian) decodes to 6.',
  recs: [rec('decimals', UINT, cat([0x06], repeat(0, 15)), '6')],
});
const A5A_RECS = [R.name('Acme'), rec('note', UTF8, EMPTY)];
const A5B_RECS = [R.name('Acme'), rec('blob', BYTES, EMPTY)];
const A5C_RECS = [R.name('Acme'), rec('meta', JSON_T, 'null')];
acceptVector({
  id: 'A5a',
  testId: 'A5',
  description: 'Non-tombstones: an empty string (type 1, key "note") is an ordinary value.',
  recs: A5A_RECS,
});
acceptVector({
  id: 'A5b',
  testId: 'A5',
  description: 'Non-tombstones: empty bytes (type 0, key "blob") are an ordinary value.',
  recs: A5B_RECS,
});
acceptVector({
  id: 'A5c',
  testId: 'A5',
  description: 'Non-tombstones: JSON null (type 3, key "meta") is an ordinary value.',
  recs: A5C_RECS,
});
const A6_RECS = [R.image(IMAGE_URI), R.imageSha256(IMAGE_SHA256)];
acceptVector({
  id: 'A6',
  testId: 'A6',
  description: `Image: image = "${IMAGE_URI}" (type 4) and a 32-byte image_sha256 (type 0, the SHA-256 of the S12 test content) in one event. Records at offsets 33 and 69; content ends at 116.`,
  recs: A6_RECS,
  offsets: [33, 69],
  contentEnd: 116,
});

// ===============================================================================================================
// Normative payload vectors — "Must reject the whole event"
// ===============================================================================================================

const K = 0x6b; // "k"
const X = 0x78; // "x"
/** name = "A": 04 6e616d65 01 01 41 (8 bytes, offsets 33..40). */
const NAME_A_AT_33: Array<[number, Bytes | number[]]> = [[33, [0x04, 0x6e, 0x61, 0x6d, 0x65, 0x01, 0x01, 0x41]]];

rejectVector('R1', 'R1', 'A header with no records: bytes 33..255 are all zero.', raw(D11, 3, []), 'no-records', 33);
rejectVector(
  'R2a',
  'R2',
  'A 221-byte key with an empty value: keyLen 221 at 33, key 34..254, valType 00 at 255; the length byte would be at 256 (past the payload).',
  raw(D11, 3, [
    [33, [221]],
    [34, repeat(K, 221)],
    [255, [0x00]],
  ]),
  'vallen-out-of-bounds',
  33,
);
rejectVector(
  'R2b',
  'R2',
  'A 1-byte key with a 220-byte value: keyLen 1, key "v", valType 00, valLen 220 at 36; the value would end at 257.',
  raw(D11, 3, [
    [33, [0x01, 0x76, 0x00, 220]],
    [37, repeat(X, 219)],
  ]),
  'value-out-of-bounds',
  33,
);
rejectVector(
  'R2c',
  'R2',
  'A 222-byte key ends exactly at byte 256: the type byte would be at 256 (past the payload).',
  raw(D11, 3, [
    [33, [222]],
    [34, repeat(K, 222)],
  ]),
  'valtype-out-of-bounds',
  33,
);
rejectVector(
  'R2d',
  'R2',
  'After a valid record (name = "A", 33..40), a record with keyLen 213 puts its type byte at 255; its length byte would be at 256.',
  raw(D11, 3, [...NAME_A_AT_33, [41, [213]], [42, repeat(K, 213)], [255, [0x01]]]),
  'vallen-out-of-bounds',
  41,
);
rejectVector(
  'R2e',
  'R2',
  'A valid type-0 record (key "k", 218-byte value) ends at 255; byte 255 is keyLen 1, so the key would be at 256.',
  raw(D11, 3, [
    [33, [0x01, K, 0x00, 218]],
    [37, repeat(X, 218)],
    [255, [0x01]],
  ]),
  'key-out-of-bounds',
  255,
);
rejectVector(
  'R2f',
  'R2',
  'keyLen 255 at 33: the key would occupy 34..288 (past the payload).',
  raw(D11, 3, [
    [33, [255]],
    [34, repeat(K, 222)],
  ]),
  'key-out-of-bounds',
  33,
);
rejectVector(
  'R3a',
  'R3',
  'After a valid record (name = "A", 33..40), a zero keyLen at 41 followed by the non-zero byte 01 at 42.',
  raw(D11, 3, [...NAME_A_AT_33, [42, [0x01]]]),
  'nonzero-padding',
  42,
);
rejectVector(
  'R3b',
  'R3',
  'After a valid record (name = "A", 33..40), a zero keyLen at 41 and a non-zero byte 01 at the last offset, 255.',
  raw(D11, 3, [...NAME_A_AT_33, [255, [0x01]]]),
  'nonzero-padding',
  255,
);
for (const [id, kind] of [
  ['R4a', 0],
  ['R4b', 4],
  ['R4c', 255],
] as Array<[string, number]>) {
  rejectVector(id, 'R4', `kind ${kind} (byte 32) with otherwise valid A1 records.`, build(D11, kind, A1_RECS).bytes, 'bad-kind', 32);
}
rejectVector(
  'R4d',
  'R4',
  'valType 6 (reserved): key "x", valType 06, valLen 0.',
  build(D11, 3, [rec('x', 6, EMPTY)]).bytes,
  'reserved-valtype',
  33,
);
rejectVector(
  'R4e',
  'R4',
  'valType 255 (reserved): key "x", valType ff, valLen 0.',
  build(D11, 3, [rec('x', 255, EMPTY)]).bytes,
  'reserved-valtype',
  33,
);
rejectVector(
  'R5a',
  'R5',
  'Invalid UTF-8 in a type-1 value: "Acme" ff "Token".',
  build(D11, 3, [rec('name', UTF8, cat(utf8('Acme'), [0xff], utf8('Token')))]).bytes,
  'invalid-utf8',
  33,
);
rejectVector(
  'R5b',
  'R5',
  'Invalid UTF-8 in a type-3 value: 22 c3 28 22 (a JSON string whose bytes are not UTF-8).',
  build(D11, 3, [rec('meta', JSON_T, [0x22, 0xc3, 0x28, 0x22])]).bytes,
  'invalid-utf8',
  33,
);
rejectVector(
  'R5c',
  'R5',
  'Invalid UTF-8 in a type-4 value: "https://acme.example/" followed by the overlong encoding c0 af.',
  build(D11, 3, [rec('uri', URI, cat(utf8('https://acme.example/'), [0xc0, 0xaf]))]).bytes,
  'invalid-utf8',
  33,
);
rejectVector(
  'R5d',
  'R5',
  'Invalid JSON in a type-3 value: {"name":"Acme" (unterminated object).',
  build(D11, 3, [rec('meta', JSON_T, '{"name":"Acme"')]).bytes,
  'invalid-json',
  33,
);
rejectVector(
  'R5e',
  'R5',
  'A relative URI in a type-4 value: /relative/path.',
  build(D11, 3, [rec('uri', URI, '/relative/path')]).bytes,
  'invalid-uri',
  33,
);
rejectVector(
  'R5f',
  'R5',
  'An integer of 0 bytes: decimals, valType 2, valLen 0.',
  build(D11, 3, [rec('decimals', UINT, EMPTY)]).bytes,
  'bad-integer-length',
  33,
);
rejectVector(
  'R5g',
  'R5',
  'An integer of 32 bytes: decimals, valType 2, valLen 32 (06 followed by 31 zero bytes).',
  build(D11, 3, [rec('decimals', UINT, cat([0x06], repeat(0, 31)))]).bytes,
  'bad-integer-length',
  33,
);
rejectVector(
  'R5h',
  'R5',
  'A Null record with valLen 1: key "retire", valType 5, valLen 1, value 00.',
  build(D11, 3, [rec('retire', NULL, [0x00])]).bytes,
  'bad-null-length',
  33,
);
rejectVector(
  'R5i',
  'R5',
  'Invalid UTF-8 in a key: the 4-byte key ff 6b 65 79 (type-1 value "ok"). Keys MUST be valid UTF-8.',
  build(D11, 3, [rec([0xff, 0x6b, 0x65, 0x79], UTF8, 'ok')]).bytes,
  'invalid-utf8-key',
  33,
);
rejectVector(
  'R6a',
  'R6',
  'A valid record (name = "Acme", 33..43) followed by an invalid one (symbol with the non-UTF-8 value ff, at 44).',
  build(D11, 3, [R.name('Acme'), rec('symbol', UTF8, [0xff])]).bytes,
  'invalid-utf8',
  44,
);
rejectVector(
  'R6b',
  'R6',
  'A valid tombstone (Null at key "retire", 33..41) followed by an invalid record (valType 6, at 42).',
  build(D11, 3, [R.tombstone('retire'), rec('x', 6, EMPTY)]).bytes,
  'reserved-valtype',
  42,
);

// ===============================================================================================================
// Normative payload vectors — "Must ignore"
// ===============================================================================================================

ignoreVector(
  'I1a',
  'A Misc event named mip-0018:token-metadata[v2] with the (valid) A1 payload is ignored, not accepted.',
  { name: NAME_V2, payload: A1.bytes },
  'other-name',
);
ignoreVector(
  'I1b',
  'A Misc event named mip-0018:token-metadata[v2] whose payload would be rejected under v1 (no records) is ignored, not rejected.',
  { name: NAME_V2, payload: raw(D11, 3, []) },
  'other-name',
);
ignoreVector(
  'I2a',
  'A Misc event with another name (acme:token-metadata[v1]) and the A1 payload is ignored.',
  { name: NAME_OTHER, payload: A1.bytes },
  'other-name',
);
ignoreVector(
  'I2b',
  'A Misc event whose name is the v1 text with a non-zero byte (01) at name byte 31 is a different name and is ignored.',
  { name: NAME_V1_DIRTY, payload: A1.bytes },
  'other-name',
);
ignoreVector(
  'I3',
  'An event of another MIP-0002 type (UnshieldedMint) is ignored even if its data bytes equal a valid MIP-0018 name and A1 payload.',
  { type: 'UnshieldedMint', name: NAME_V1, payload: A1.bytes },
  'not-misc',
);

// ===============================================================================================================
// Normative state vectors
// ===============================================================================================================

stateVector({
  id: 'A3a-state',
  testId: 'A3',
  description:
    'Exact bytes (state): the A3a event sets "symbol" = "ACME" and "symbol\\0" = "ZZZ", two different keys: symbol stays "ACME". "symbol\\0" is neither a common key nor defined by a declared standard, so it is not served.',
  steps: [apply({ block: 1, recs: [R.symbol('ACME'), rec(cat(utf8('symbol'), [0x00]), UTF8, 'ZZZ')] })],
  identities: [identity({ kind: 3, fields: [F.symbol('ACME', true)] })],
});
stateVector({
  id: 'A4b-state',
  testId: 'A4',
  description:
    'Integer widths (state): decimals as Uint<128> (06 + 15 zero bytes) is a usable decimals of 6; raw 1234567 displays as 1.234567.',
  steps: [apply({ block: 1, recs: [rec('decimals', UINT, cat([0x06], repeat(0, 15)), '6')] })],
  identities: [identity({ kind: 3, fields: [field('decimals', UINT, cat([0x06], repeat(0, 15)), true)] })],
  display: [display({ kind: 3, raw: '1234567', decimals: '6', text: '1.234567' })],
});
// A5 (state): an empty string, empty bytes and JSON null replace a common field's value; the field keeps a value (it
// is unusable), it is not deleted as a Null record would delete it.
stateVector({
  id: 'A5a-state',
  testId: 'A5',
  description:
    'Non-tombstones (state): after name = "Acme", symbol = "ACME", an empty string at symbol (type 1) is an ordinary value: symbol has the value "" (unusable), it is not deleted.',
  steps: [apply({ block: 1, recs: [R.name('Acme'), R.symbol('ACME')] }), apply({ block: 2, recs: [rec('symbol', UTF8, EMPTY)] })],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), F.symbol('', false)] })],
});
stateVector({
  id: 'A5b-state',
  testId: 'A5',
  description:
    'Non-tombstones (state): after name = "Acme" and a 32-byte image_sha256, empty bytes at image_sha256 (type 0) are an ordinary value: image_sha256 has the empty value (unusable), it is not deleted.',
  steps: [
    apply({ block: 1, recs: [R.name('Acme'), R.imageSha256(IMAGE_SHA256)] }),
    apply({ block: 2, recs: [rec('image_sha256', BYTES, EMPTY)] }),
  ],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), field('image_sha256', BYTES, EMPTY, false)] })],
});
stateVector({
  id: 'A5c-state',
  testId: 'A5',
  description:
    'Non-tombstones (state): after name = "Acme", standards = "mip-0004", JSON null at standards (type 3) is an ordinary value: standards has the value null (unusable), it is not deleted.',
  steps: [
    apply({ block: 1, recs: [R.name('Acme'), R.standards('mip-0004')] }),
    apply({ block: 2, recs: [rec('standards', JSON_T, 'null')] }),
  ],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), field('standards', JSON_T, 'null', false)] })],
});
stateVector({
  id: 'A6-state',
  testId: 'A6',
  description: `Image (state): the A6 event gives the identity a usable image ("${IMAGE_URI}", type 4) and a usable 32-byte image_sha256 (type 0).`,
  steps: [apply({ block: 1, recs: A6_RECS })],
  identities: [identity({ kind: 3, fields: [field('image', URI, IMAGE_URI, true), field('image_sha256', BYTES, IMAGE_SHA256, true)] })],
});

// S1 — order within an event
stateVector({
  id: 'S1a',
  testId: 'S1',
  description:
    'Order within an event: for kind 1, name = "A" (33), Null at key "name" (41), name = "B" (48) leave the identity with only name = "B".',
  steps: [apply({ block: 1, kind: 1, recs: [R.name('A'), R.tombstone('name'), R.name('B')], offsets: [33, 41, 48] })],
  identities: [identity({ kind: 1, fields: [F.name('B', true)] })],
});
stateVector({
  id: 'S1b',
  testId: 'S1',
  description: 'Order within an event: for kind 1, name = "A" (33) then name = "B" (41) in one event leave name = "B".',
  steps: [apply({ block: 1, kind: 1, recs: [R.name('A'), R.name('B')], offsets: [33, 41] })],
  identities: [identity({ kind: 1, fields: [F.name('B', true)] })],
});

// S2 — latest value wins
const S2_FINAL = [F.name('Beta', true), F.symbol('ALP', true), F.decimals(2, true), F.standards('mip-0004', true)];
stateVector({
  id: 'S2a',
  testId: 'S2',
  description:
    'Latest value wins: name "Alpha", symbol "ALP", decimals 2, standards "mip-0004" as four events (blocks 1-2), then an event with only name = "Beta" (block 3): only name changes; "Alpha" is not current.',
  steps: [
    apply({ block: 1, tx: 0, event: 0, recs: [R.name('Alpha')] }),
    apply({ block: 1, tx: 0, event: 1, recs: [R.symbol('ALP')] }),
    apply({ block: 1, tx: 1, event: 0, recs: [R.decimals(2)] }),
    apply({ block: 2, recs: [R.standards('mip-0004')] }),
    apply({ block: 3, recs: [R.name('Beta')] }),
  ],
  identities: [identity({ kind: 3, fields: S2_FINAL })],
});
stateVector({
  id: 'S2b',
  testId: 'S2',
  description: 'Latest value wins: the same four records as one event (block 1), then name = "Beta" (block 2): same state as S2a.',
  steps: [
    apply({ block: 1, recs: [R.name('Alpha'), R.symbol('ALP'), R.decimals(2), R.standards('mip-0004')] }),
    apply({ block: 2, recs: [R.name('Beta')] }),
  ],
  identities: [identity({ kind: 3, fields: S2_FINAL })],
});

// S3 — tombstone (MIP "Applying records": a Null record deletes its field; an identity with no field left is not
// referenced)
const S3_K1_RECS = [R.name('Gold'), R.symbol('GLD'), R.decimals(6), R.standards('mip-0011')];
const S3_K3_RECS = [R.name('Gold'), R.symbol('GLD'), R.decimals(6), R.standards('mip-0004')];
const S3_K3_FIELDS = [F.name('Gold', true), F.symbol('GLD', true), F.decimals(6, true), F.standards('mip-0004', true)];
/** Kind 1 after the Null at `name`: the other three fields stay. */
const S3_K1_NO_NAME = [F.symbol('GLD', true), F.decimals(6, true), F.standards('mip-0011', true)];
const S3_PUBLISH = [apply({ block: 1, event: 0, kind: 1, recs: S3_K1_RECS }), apply({ block: 1, event: 1, kind: 3, recs: S3_K3_RECS })];
/** Block 2: Null at `name` for kind 1. */
const S3_NULL_NAME = [apply({ block: 2, kind: 1, recs: [R.tombstone('name')] })];
/** Block 3: a second Null at `name`; block 4: a Null at `retire`, a key that never had a value. */
const S3_NO_EFFECT = [
  apply({ block: 3, kind: 1, recs: [R.tombstone('name')] }),
  apply({ block: 4, kind: 1, recs: [R.tombstone('retire')] }),
];
/** Block 5: Null records for kind 1's remaining keys, in one event. */
const S3_NULL_REST = (block: number) =>
  apply({
    block,
    kind: 1,
    recs: [R.tombstone('symbol'), R.tombstone('decimals'), R.tombstone('standards')],
    offsets: [33, 42, 53],
  });
stateVector({
  id: 'S3a',
  testId: 'S3',
  description:
    'Tombstone: name/symbol/decimals/standards for kinds 1 and 3 under one domainSep (block 1), then a Null record at key "name" for kind 1 (block 2): kind 1 keeps symbol, decimals and standards and has no name; kind 3 is unchanged.',
  steps: [...S3_PUBLISH, ...S3_NULL_NAME],
  identities: [identity({ kind: 1, fields: S3_K1_NO_NAME }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S3b',
  testId: 'S3',
  description:
    'Tombstone: after S3a, a second Null at "name" (block 3) and a Null at "retire", a key with no value (block 4), change nothing.',
  steps: [...S3_PUBLISH, ...S3_NULL_NAME, ...S3_NO_EFFECT],
  identities: [identity({ kind: 1, fields: S3_K1_NO_NAME }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S3c',
  testId: 'S3',
  description:
    "Tombstone: after S3b, Null records for kind 1's remaining keys (symbol, decimals, standards) in one event (block 5) leave kind 1 with no fields, so it is not referenced anywhere (absent from the identities); kind 3 is unchanged.",
  steps: [...S3_PUBLISH, ...S3_NULL_NAME, ...S3_NO_EFFECT, S3_NULL_REST(5)],
  identities: [identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S3d',
  testId: 'S3',
  description:
    'Tombstone: after S3c, a kind-1 name = "New" (block 6) describes kind 1 again with only name; standards reads as empty (no field) and the earlier list does not return.',
  steps: [...S3_PUBLISH, ...S3_NULL_NAME, ...S3_NO_EFFECT, S3_NULL_REST(5), apply({ block: 6, kind: 1, recs: [R.name('New')] })],
  identities: [identity({ kind: 1, fields: [F.name('New', true)] }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});

// S4 — reorganization
stateVector({
  id: 'S4a',
  testId: 'S4',
  description:
    "Reorganization: S3c, then block 5 (the block that deleted kind 1's last fields) is removed: those fields (symbol, decimals, standards) are restored; name stays deleted (block 2 is still canonical).",
  steps: [...S3_PUBLISH, ...S3_NULL_NAME, ...S3_NO_EFFECT, S3_NULL_REST(5), rollback(NET_A, 4)],
  identities: [identity({ kind: 1, fields: S3_K1_NO_NAME }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S4b',
  testId: 'S4',
  description: "Reorganization: S4a, then block 5 is added again: kind 1's last fields are deleted again and kind 1 is not referenced.",
  steps: [...S3_PUBLISH, ...S3_NULL_NAME, ...S3_NO_EFFECT, S3_NULL_REST(5), rollback(NET_A, 4), S3_NULL_REST(5)],
  identities: [identity({ kind: 3, fields: S3_K3_FIELDS })],
});

// S5 — unusable fields
stateVector({
  id: 'S5a',
  testId: 'S5',
  description:
    'Unusable fields: after name = "Acme", an event with an empty name (and symbol = "ACM2") is accepted: name is unusable with no fallback to "Acme"; symbol from the same event applies.',
  steps: [apply({ block: 1, recs: [R.name('Acme'), R.symbol('ACME')] }), apply({ block: 2, recs: [R.name(''), R.symbol('ACM2')] })],
  identities: [identity({ kind: 3, fields: [F.name('', false), F.symbol('ACM2', true)] })],
});
stateVector({
  id: 'S5b',
  testId: 'S5',
  description:
    'Unusable fields: after decimals = 6 (type 2), a type-1 decimals of "6" is accepted and makes decimals unusable, with no fallback to 6.',
  steps: [apply({ block: 1, recs: [R.name('Acme'), R.decimals(6)] }), apply({ block: 2, recs: [rec('decimals', UTF8, '6')] })],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), field('decimals', UTF8, '6', false)] })],
});
stateVector({
  id: 'S5c',
  testId: 'S5',
  description:
    'Unusable fields: after standards = "mip-0004", standards = "mip-0004  mip-0011" (two spaces) is accepted and makes standards unusable (not empty), with no fallback.',
  steps: [
    apply({ block: 1, recs: [R.name('Acme'), R.standards('mip-0004')] }),
    apply({ block: 2, recs: [R.standards('mip-0004  mip-0011')] }),
  ],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), F.standards('mip-0004  mip-0011', false)] })],
});

// S6 — separate identities
const S6_RECS = [R.name('Acme'), R.symbol('ACME'), R.decimals(6)];
const s6Fields = (n: string) => [F.name(n, true), F.symbol('ACME', true), F.decimals(6, true)];
stateVector({
  id: 'S6a',
  testId: 'S6',
  description:
    'Separate identities: the same records under kinds 1, 2 and 3 create three identities; renaming kind 2 leaves kinds 1 and 3 unchanged; kinds 1 and 2 get a color, kind 3 does not.',
  steps: [
    apply({ block: 1, event: 0, kind: 1, recs: S6_RECS }),
    apply({ block: 1, event: 1, kind: 2, recs: S6_RECS }),
    apply({ block: 1, event: 2, kind: 3, recs: S6_RECS }),
    apply({ block: 2, kind: 2, recs: [R.name('Acme Unshielded')] }),
  ],
  identities: [
    identity({ kind: 1, colored: true, fields: s6Fields('Acme') }),
    identity({ kind: 2, colored: true, fields: s6Fields('Acme Unshielded') }),
    identity({ kind: 3, colored: false, fields: s6Fields('Acme') }),
  ],
});
stateVector({
  id: 'S6b',
  testId: 'S6',
  description: 'Separate identities: the same kind-1 payload from contracts A and B creates two identities; renaming B leaves A unchanged.',
  steps: [
    apply({ block: 1, tx: 0, contract: CONTRACT_A, kind: 1, recs: S6_RECS }),
    apply({ block: 1, tx: 1, contract: CONTRACT_B, kind: 1, recs: S6_RECS }),
    apply({ block: 2, contract: CONTRACT_B, kind: 1, recs: [R.name('Bravo')] }),
  ],
  identities: [
    identity({ contract: CONTRACT_A, kind: 1, colored: true, fields: s6Fields('Acme') }),
    identity({ contract: CONTRACT_B, kind: 1, colored: true, fields: s6Fields('Bravo') }),
  ],
});

// S7 — independent events
stateVector({
  id: 'S7a',
  testId: 'S7',
  description:
    'Independent events: in one transaction, event 0 is malformed (symbol = "EVIL", then a valType-6 record) and event 1 sets name = "Good": event 0 is rejected entirely, event 1 applies.',
  steps: [
    apply({ block: 1, tx: 0, event: 0, recs: [R.symbol('EVIL'), rec('x', 6, EMPTY)] }),
    apply({ block: 1, tx: 0, event: 1, recs: [R.name('Good')] }),
  ],
  identities: [identity({ kind: 3, fields: [F.name('Good', true)] })],
});
stateVector({
  id: 'S7b',
  testId: 'S7',
  description:
    'Independent events: in one transaction, event 0 sets name = "Good" and event 1 is malformed (name = "Evil", then a valType-6 record): event 0 stays applied, event 1 is rejected entirely.',
  steps: [
    apply({ block: 1, tx: 0, event: 0, recs: [R.name('Good')] }),
    apply({ block: 1, tx: 0, event: 1, recs: [R.name('Evil'), rec('x', 6, EMPTY)] }),
  ],
  identities: [identity({ kind: 3, fields: [F.name('Good', true)] })],
});

// S8 — display
stateVector({
  id: 'S8',
  testId: 'S8',
  description: 'Display: with decimals = 2, the raw amount 123456 displays as 1234.56.',
  steps: [apply({ block: 1, recs: [R.decimals(2)] })],
  identities: [identity({ kind: 3, fields: [F.decimals(2, true)] })],
  display: [display({ kind: 3, raw: '123456', decimals: '2', text: '1234.56' })],
});

// S9 — symbol grouping
const S9_BASE = [
  apply({ block: 1, tx: 0, event: 0, domainSep: D11, kind: 1, recs: [R.name('Acme Shielded'), R.symbol('ACME')] }),
  apply({ block: 1, tx: 0, event: 1, domainSep: D11, kind: 3, recs: [R.name('Acme Ledger'), R.symbol('ACME')] }),
  apply({ block: 1, tx: 0, event: 2, domainSep: D22, kind: 1, recs: [R.name('Acme Two'), R.symbol('ACME')] }),
  apply({ block: 1, tx: 1, event: 0, contract: CONTRACT_B, domainSep: D11, kind: 1, recs: [R.name('Other Contract'), R.symbol('ACME')] }),
  apply({ block: 1, tx: 2, event: 0, domainSep: D33, kind: 3, recs: [R.name('Lower Case'), R.symbol('acme')] }),
  apply({ block: 1, tx: 2, event: 1, domainSep: D44, kind: 3, recs: [R.name('Leading Space'), R.symbol(' ACME')] }),
  apply({ block: 1, tx: 2, event: 2, domainSep: D55, kind: 3, recs: [R.name('Bytes Symbol'), rec('symbol', BYTES, 'ACME')] }),
  apply({ block: 1, tx: 2, event: 3, domainSep: D66, kind: 3, recs: [R.name('Upper Key'), rec('SYMBOL', UTF8, 'ACME')] }),
  apply({ block: 1, tx: 2, event: 4, domainSep: D77, kind: 3, recs: [R.name('No Symbol')] }),
  apply({ network: NET_B, block: 1, domainSep: D11, kind: 1, recs: [R.name('Other Network'), R.symbol('ACME')] }),
];
interface S9Opts {
  ledgerName?: string;
  twoSymbol?: string;
  /** The kind-3 member's `symbol` was deleted: it keeps only its name. */
  ledgerNoSymbol?: boolean;
}
function s9Identities(o: S9Opts = {}): Array<Record<string, unknown>> {
  return [
    identity({ domainSep: D11, kind: 1, fields: [F.name('Acme Shielded', true), F.symbol('ACME', true)] }),
    identity({
      domainSep: D11,
      kind: 3,
      fields: o.ledgerNoSymbol
        ? [F.name(o.ledgerName ?? 'Acme Ledger', true)]
        : [F.name(o.ledgerName ?? 'Acme Ledger', true), F.symbol('ACME', true)],
    }),
    identity({ domainSep: D22, kind: 1, fields: [F.name('Acme Two', true), F.symbol(o.twoSymbol ?? 'ACME', true)] }),
    identity({ contract: CONTRACT_B, domainSep: D11, kind: 1, fields: [F.name('Other Contract', true), F.symbol('ACME', true)] }),
    identity({ domainSep: D33, kind: 3, fields: [F.name('Lower Case', true), F.symbol('acme', true)] }),
    identity({ domainSep: D44, kind: 3, fields: [F.name('Leading Space', true), F.symbol(' ACME', true)] }),
    identity({ domainSep: D55, kind: 3, fields: [F.name('Bytes Symbol', true), field('symbol', BYTES, 'ACME', false)] }),
    // The key "SYMBOL" is neither a common key nor defined by a declared standard: not served.
    identity({ domainSep: D66, kind: 3, fields: [F.name('Upper Key', true)] }),
    identity({ domainSep: D77, kind: 3, fields: [F.name('No Symbol', true)] }),
    identity({ network: NET_B, domainSep: D11, kind: 1, fields: [F.name('Other Network', true), F.symbol('ACME', true)] }),
  ];
}
const S9_OTHER_GROUPS = [
  group(NET_A, CONTRACT_B, 'ACME', [[D11, 1]]),
  group(NET_B, CONTRACT_A, 'ACME', [[D11, 1]]),
  group(NET_A, CONTRACT_A, 'acme', [[D33, 3]]),
  group(NET_A, CONTRACT_A, ' ACME', [[D44, 3]]),
];
const S9_SETUP =
  'Contract A on testnet-a: kinds 1 and 3 under domainSep 0x11 and kind 1 under 0x22 with symbol "ACME"; also "acme" (0x33), " ACME" (0x44), a type-0 "ACME" (0x55), key "SYMBOL" (0x66) and no symbol (0x77). Contract B on testnet-a and contract A on testnet-b each publish "ACME" under 0x11 kind 1.';
stateVector({
  id: 'S9a',
  testId: 'S9',
  description: `Symbol grouping: ${S9_SETUP} Kinds 1 and 3 of 0x11 and kind 1 of 0x22 form one group; the other contract, the other network, "acme" and " ACME" are separate groups; the type-0 symbol, the key "SYMBOL" (not served) and the missing symbol are ungrouped.`,
  steps: S9_BASE,
  identities: s9Identities(),
  groups: [
    group(NET_A, CONTRACT_A, 'ACME', [
      [D11, 1],
      [D11, 3],
      [D22, 1],
    ]),
    ...S9_OTHER_GROUPS,
  ],
});
stateVector({
  id: 'S9b',
  testId: 'S9',
  description:
    'Symbol grouping: after S9a, renaming the kind-3 member (name = "Acme Ledger Renamed") changes no other member and no group.',
  steps: [...S9_BASE, apply({ block: 2, domainSep: D11, kind: 3, recs: [R.name('Acme Ledger Renamed')] })],
  identities: s9Identities({ ledgerName: 'Acme Ledger Renamed' }),
  groups: [
    group(NET_A, CONTRACT_A, 'ACME', [
      [D11, 1],
      [D11, 3],
      [D22, 1],
    ]),
    ...S9_OTHER_GROUPS,
  ],
});
stateVector({
  id: 'S9c',
  testId: 'S9',
  description: 'Symbol grouping: after S9a, changing the symbol of the 0x22 member to "GOLD" moves only that member into its own group.',
  steps: [...S9_BASE, apply({ block: 2, domainSep: D22, kind: 1, recs: [R.symbol('GOLD')] })],
  identities: s9Identities({ twoSymbol: 'GOLD' }),
  groups: [
    group(NET_A, CONTRACT_A, 'ACME', [
      [D11, 1],
      [D11, 3],
    ]),
    group(NET_A, CONTRACT_A, 'GOLD', [[D22, 1]]),
    ...S9_OTHER_GROUPS,
  ],
});
stateVector({
  id: 'S9d',
  testId: 'S9',
  description:
    'Symbol grouping: after S9a, a Null record at "symbol" for the kind-3 member removes it from the group; it keeps its name and is ungrouped.',
  steps: [...S9_BASE, apply({ block: 2, domainSep: D11, kind: 3, recs: [R.tombstone('symbol')] })],
  identities: s9Identities({ ledgerNoSymbol: true }),
  groups: [
    group(NET_A, CONTRACT_A, 'ACME', [
      [D11, 1],
      [D22, 1],
    ]),
    ...S9_OTHER_GROUPS,
  ],
});

// S10 — served keys (MIP "Keys": consumers MUST NOT serve a key that is neither a common key nor defined by a standard
// the token currently declares; the served keys follow the current `standards`)
stateVector({
  id: 'S10a',
  testId: 'S10',
  description:
    'Served keys: foo = "x" (type 1) is accepted but not served. Kind 3 gets only foo = "x" (block 1, event 0): it has no served field and is not referenced. Kind 1 gets name = "Acme" and foo = "x" in one event (event 1): only name is served.',
  steps: [
    apply({ block: 1, event: 0, kind: 3, recs: [rec('foo', UTF8, 'x')] }),
    apply({ block: 1, event: 1, kind: 1, recs: [R.name('Acme'), rec('foo', UTF8, 'x')] }),
  ],
  identities: [identity({ kind: 1, fields: [F.name('Acme', true)] })],
});
/** A test standard that defines key `k` (type 1); the consumer loads it from the vector before the steps. */
const S10_DEFINED = { 'test-s10': [{ key: 'k', valType: UTF8 }] };
const S10_K = (v: string, usable = true) => field('k', UTF8, v, usable);
const S10_STEPS = [
  apply({ block: 1, recs: [R.name('Acme'), rec('k', UTF8, 'v')] }),
  apply({ block: 2, recs: [R.standards('test-s10')] }),
  apply({ block: 3, recs: [rec('k', UTF8, 'w')] }),
  apply({ block: 4, recs: [R.standards('')] }),
  apply({ block: 5, recs: [R.standards('test-s10')] }),
];
const S10_SETUP =
  'The vector defines the test standard "test-s10" with key "k" (type 1) in definedKeys, which the consumer loads before the steps.';
stateVector({
  id: 'S10b',
  testId: 'S10',
  description: `Served keys: ${S10_SETUP} name = "Acme" and k = "v" before standards lists "test-s10" (block 1): k is not served.`,
  definedKeys: S10_DEFINED,
  steps: S10_STEPS.slice(0, 1),
  identities: [identity({ kind: 3, fields: [F.name('Acme', true)] })],
});
stateVector({
  id: 'S10c',
  testId: 'S10',
  description: `Served keys: ${S10_SETUP} After S10b, standards = "test-s10" (block 2): k = "v", sent before the standard was declared, is served.`,
  definedKeys: S10_DEFINED,
  steps: S10_STEPS.slice(0, 2),
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), F.standards('test-s10', true), S10_K('v')] })],
});
stateVector({
  id: 'S10d',
  testId: 'S10',
  description: `Served keys: ${S10_SETUP} After S10c, k = "w" while "test-s10" is declared (block 3), then standards = "" (block 4): k is not served.`,
  definedKeys: S10_DEFINED,
  steps: S10_STEPS.slice(0, 4),
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), F.standards('', true)] })],
});
stateVector({
  id: 'S10e',
  testId: 'S10',
  description: `Served keys: ${S10_SETUP} After S10d, standards = "test-s10" again (block 5): k is served again, with its latest value "w".`,
  definedKeys: S10_DEFINED,
  steps: S10_STEPS,
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), F.standards('test-s10', true), S10_K('w')] })],
});

// S11 — name and symbol length (MIP "Common fields": `name` 1–64 characters, `symbol` 1–12; an over-length value is
// still usable and is truncated; MIP "Terminology": a character is a grapheme cluster, Unicode UAX #29). The values
// mix ASCII with multi-code-point clusters whose segmentation has been the same in every Unicode version since 6.2:
// base letters with combining marks (GB9), regional-indicator flag pairs (GB12/GB13) and Hangul L+V+T jamo (GB6/GB7).
// The clusters are listed by hand (the oracle); truncating by code points or bytes gives other results.
const GC = {
  eAcute: 'e\u0301', // e + COMBINING ACUTE ACCENT
  aRing: 'A\u030A', // A + COMBINING RING ABOVE
  oDiaMacron: 'o\u0308\u0304', // o + COMBINING DIAERESIS + COMBINING MACRON
  flagUY: '\u{1F1FA}\u{1F1FE}', // REGIONAL INDICATOR U + Y
  flagJP: '\u{1F1EF}\u{1F1F5}', // REGIONAL INDICATOR J + P
  hangulHan: '\u1112\u1161\u11AB', // HIEUH + A + NIEUN (conjoining jamo L V T)
  hangulGag: '\u1100\u1161\u11A8', // KIYEOK + A + KIYEOK (conjoining jamo L V T)
};
const NAME_HEAD = [
  ...'Acme Caf',
  GC.eAcute,
  ...' token ',
  GC.flagUY,
  ' ',
  GC.hangulHan,
  GC.hangulGag,
  ' ',
  GC.aRing,
  ...'ngstr',
  GC.oDiaMacron,
  ...'m, seventy characters for test S11a',
  GC.flagJP,
];
const NAME_CLUSTERS = [...NAME_HEAD, GC.hangulHan, ...' tail'];
const SYMBOL_CLUSTERS = [
  GC.aRing,
  'C',
  'M',
  GC.eAcute,
  GC.flagUY,
  GC.hangulHan,
  'X',
  'Y',
  'Z',
  GC.oDiaMacron,
  '1',
  '2',
  '3',
  GC.flagJP,
  GC.hangulGag,
];
check(NAME_HEAD.length === 64 && NAME_CLUSTERS.length === 70, 'the S11a name has 70 characters, 64 kept');
check(SYMBOL_CLUSTERS.length === 15, 'the S11b symbol has 15 characters');
{
  // Authoring check only (the lists above are the oracle): each listed cluster is one grapheme cluster here too.
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const list of [NAME_CLUSTERS, SYMBOL_CLUSTERS])
    check(Array.from(seg.segment(list.join('')), (x) => x.segment).join('|') === list.join('|'), 'grapheme clusters as listed');
}
const NAME_70 = NAME_CLUSTERS.join('');
const NAME_64 = NAME_HEAD.join('');
const SYMBOL_15 = SYMBOL_CLUSTERS.join('');
const SYMBOL_12 = SYMBOL_CLUSTERS.slice(0, 12).join('');
check(Array.from(NAME_70).length > 70 && Array.from(NAME_64).length > 64, 'S11a: code points are more than characters');
stateVector({
  id: 'S11a',
  testId: 'S11',
  description: `Name length: a 70-character name (${Array.from(NAME_70).length} code points, ${utf8(NAME_70).length} bytes; combining marks, flags, Hangul L+V+T) is usable and truncated to its first 64 characters (grapheme clusters; ${utf8(NAME_64).length} bytes, ending with a flag).`,
  steps: [apply({ block: 1, recs: [R.name(NAME_70)] })],
  identities: [identity({ kind: 3, fields: [F.name(NAME_64, true)] })],
});
stateVector({
  id: 'S11b',
  testId: 'S11',
  description: `Symbol length: a 15-character symbol (${Array.from(SYMBOL_15).length} code points, ${utf8(SYMBOL_15).length} bytes) is usable and truncated to its first 12 characters (grapheme clusters; ${utf8(SYMBOL_12).length} bytes).`,
  steps: [apply({ block: 1, recs: [R.symbol(SYMBOL_15)] })],
  identities: [identity({ kind: 3, fields: [F.symbol(SYMBOL_12, true)] })],
});

// S12 — image hash (MIP "Common fields": with image_sha256 set, content from image whose SHA-256 differs is not
// displayed; an image_sha256 that is not 32 bytes is unusable)
stateVector({
  id: 'S12a',
  testId: 'S12',
  description: `Image hash: image = "${IMAGE_URI}" and image_sha256 = SHA-256 of the test content: content whose SHA-256 differs is not displayed. (Displaying the matching content is up to the consumer.)`,
  steps: [apply({ block: 1, recs: [R.name('Acme'), ...A6_RECS] })],
  identities: [
    identity({
      kind: 3,
      fields: [F.name('Acme', true), field('image', URI, IMAGE_URI, true), field('image_sha256', BYTES, IMAGE_SHA256, true)],
    }),
  ],
  images: [image({ kind: 3, content: IMAGE_CONTENT, displayable: true }), image({ kind: 3, content: IMAGE_OTHER, displayable: false })],
});
const IMAGE_SHA256_31 = IMAGE_SHA256.slice(0, 31);
stateVector({
  id: 'S12b',
  testId: 'S12',
  description: `Image hash: image = "${IMAGE_URI}" and a 31-byte image_sha256 (the first 31 bytes of the S12a hash): image_sha256 is unusable.`,
  steps: [apply({ block: 1, recs: [R.name('Acme'), R.image(IMAGE_URI), R.imageSha256(IMAGE_SHA256_31)] })],
  identities: [
    identity({
      kind: 3,
      fields: [F.name('Acme', true), field('image', URI, IMAGE_URI, true), field('image_sha256', BYTES, IMAGE_SHA256_31, false)],
    }),
  ],
});

// ===============================================================================================================
// Informative vectors (normative = false)
// ===============================================================================================================

// ---- URI cases (MIP Value types: the RFC 3986 `URI` rule, as ERC-721 uses it) ----
// Verdicts transcribed from the URI investigation and cross-checked below against both independent grammars.
const URI_ACCEPT = new Set([
  'c01',
  'c02',
  'c05',
  'c07',
  'c08',
  'c09',
  'c10',
  'c11',
  'c12',
  'c13',
  'c14',
  'c18',
  'c19',
  'c20',
  'c24',
  'c26',
]);
const INVESTIGATION = 'informative/uri/investigation';
const uriCases = JSON.parse(readFileSync(join(VECTORS_DIR, INVESTIGATION, 'cases.json'), 'utf8')) as Array<[string, string]>;
const nodeResults = JSON.parse(readFileSync(join(VECTORS_DIR, INVESTIGATION, 'node.json'), 'utf8')) as Record<
  string,
  { rfc3986URI: boolean }
>;
const pyResults = JSON.parse(readFileSync(join(VECTORS_DIR, INVESTIGATION, 'py.json'), 'utf8')) as Record<
  string,
  { pyRfc3987_URI: boolean }
>;
check(uriCases.length === 26, 'expected 26 URI cases');
const uriVerdicts: Array<Record<string, unknown>> = [];
for (const [caseId, value] of uriCases) {
  const accept = URI_ACCEPT.has(caseId);
  check(nodeResults[caseId]?.rfc3986URI === accept, `URI ${caseId}: verdict differs from the strict RFC 3986 grammar`);
  check(pyResults[caseId]?.pyRfc3987_URI === accept, `URI ${caseId}: verdict differs from Python rfc3987 rule URI`);
  const id = `INF-URI-${caseId}`;
  const r = rec('uri', URI, value);
  const description = `URI (valType 4) value ${JSON.stringify(value)}: ${accept ? 'accepted' : 'rejected'} under the RFC 3986 URI rule (scheme required, fragment allowed, ASCII only).`;
  const basis =
    'MIP-0018 Value types (RFC 3986 `URI`, as ERC-721 uses it). Verdict = strict RFC 3986 grammar (investigation/rfc3986.mjs) = Python rfc3987 rule URI (investigation/py.json); they agree on 26/26.';
  if (accept) {
    acceptVector({ id, testId: 'INF-URI', normative: false, description, basis, recs: [r], dir: 'informative/uri' });
  } else {
    payloadVector({
      id,
      testId: 'INF-URI',
      normative: false,
      description,
      basis,
      payload: build(D11, 3, [r]).bytes,
      expect: { result: 'reject', reason: 'invalid-uri', offset: 33 },
      dir: 'informative/uri',
    });
  }
  uriVerdicts.push({ case: caseId, value, verdict: accept ? 'accept' : 'reject', vector: `${id}.json` });
}
emit(
  'informative/uri/verdicts.json',
  json({ rule: 'RFC 3986 URI (scheme required, fragment allowed, ASCII only)', basis: 'MIP-0018 Value types', cases: uriVerdicts }),
);

// ---- standards list format and common-field forms (derived from "Common fields"; not in the MIP Testing list) ----
const STD_BASIS =
  'MIP "Common fields": standards = identifiers separated by single spaces; identifier non-empty, no byte in 0x00-0x20 or 0x7f; empty = no standards claimed; malformed = unusable.';
const stdVector = (id: string, value: string | Bytes, usable: boolean, what: string, basis: string = STD_BASIS) =>
  stateVector({
    id,
    testId: 'INF-STANDARDS',
    normative: false,
    description: `standards = ${what}: ${usable ? 'usable' : 'unusable'}.`,
    basis,
    steps: [apply({ block: 1, recs: [rec('standards', UTF8, value)] })],
    identities: [identity({ kind: 3, fields: [field('standards', UTF8, value, usable)] })],
    dir: 'informative/state',
  });
stdVector('INF-STD-1', 'mip-0004 ', false, '"mip-0004 " (trailing space: an empty identifier)');
stdVector('INF-STD-2', ' mip-0004', false, '" mip-0004" (leading space: an empty identifier)');
stdVector('INF-STD-3', 'mip-0004\tmip-0011', false, '"mip-0004<TAB>mip-0011" (0x09 is a control byte)');
stdVector('INF-STD-4', '', true, '"" (empty: no standards claimed, not malformed)');
stdVector('INF-STD-5', 'mip-0004 mip-0004 erc-20', true, '"mip-0004 mip-0004 erc-20" (duplicates carry no meaning)');
const N5_BASIS = `${STD_BASIS} The byte rule allows other Unicode spaces and controls (U+00A0, U+0085).`;
stdVector('INF-STD-6', 'mip-0004 x y', true, '"mip-0004 x<U+00A0>y" (no-break space, bytes c2 a0: no byte in 0x00-0x20/0x7f)', N5_BASIS);
stdVector(
  'INF-STD-7',
  'mip-0004 x\u0085y',
  true,
  '"mip-0004 x<U+0085>y" (C1 control NEL, bytes c2 85: no byte in 0x00-0x20/0x7f)',
  N5_BASIS,
);
stateVector({
  id: 'INF-COMMON-1',
  testId: 'INF-COMMON',
  normative: false,
  description:
    'Common fields with the wrong type or form: name as bytes (type 0), symbol empty, decimals as bytes (type 0) — all unusable; the event is accepted.',
  basis:
    'MIP "Common fields": name = UTF-8 string of 1–64 characters, symbol 1–12 (an empty one is unusable); decimals = unsigned integer; a field without that type or form is unusable.',
  steps: [apply({ block: 1, recs: [rec('name', BYTES, 'Acme'), rec('symbol', UTF8, EMPTY), rec('decimals', BYTES, [0x06])] })],
  identities: [
    identity({
      kind: 3,
      fields: [field('name', BYTES, 'Acme', false), field('symbol', UTF8, EMPTY, false), field('decimals', BYTES, [0x06], false)],
    }),
  ],
  dir: 'informative/state',
});

// ---- keys (MIP "Keys": keys MUST be valid UTF-8 — multi-byte UTF-8 is valid) ----
acceptVector({
  id: 'INF-KEY-1',
  testId: 'INF-KEY',
  normative: false,
  description: 'A multi-byte UTF-8 key ("名前", e5 90 8d e5 89 8d) is valid UTF-8 and the event is accepted.',
  basis:
    'MIP "Keys": "Keys MUST be valid UTF-8." Keys are exact bytes; any valid UTF-8 key is accepted (it is served only if a declared standard defines it).',
  recs: [rec('名前', UTF8, 'x')],
  dir: 'informative/payload',
});

// ---- name/symbol length with multi-byte characters, and grouping on the stored symbol (MIP "Common fields") ----
// Characters are grapheme clusters (MIP "Terminology"), not bytes; grouping compares the stored symbol bytes, a choice
// of this repository (informative).
const LEN_BASIS =
  'MIP "Common fields": name 1–64 characters, symbol 1–12; an over-length name or symbol is still usable and is truncated; MIP "Terminology": a character is a grapheme cluster (Unicode UAX #29). Lengths count characters, never bytes. Grouping compares the stored symbol bytes (a choice of this repository: the MIP compares a usable symbol "as exact bytes").';
const NAME_70_MB = 'é'.repeat(30) + '名'.repeat(20) + '😀'.repeat(20);
check(Array.from(NAME_70_MB).length === 70 && utf8(NAME_70_MB).length === 200, 'INF-LEN-1 name: 70 characters, 200 bytes');
const NAME_64_MB = 'é'.repeat(30) + '名'.repeat(20) + '😀'.repeat(14);
stateVector({
  id: 'INF-LEN-1',
  testId: 'INF-LEN',
  normative: false,
  description:
    'A name of 70 characters in 200 bytes (30 × "é" U+00E9, 2 bytes; 20 × "名", 3 bytes; 20 × "😀", 4 bytes; one code point each) is truncated to its first 64 characters (30 × "é", 20 × "名", 14 × "😀"; 176 bytes), not to 64 bytes.',
  basis: LEN_BASIS,
  steps: [apply({ block: 1, recs: [R.name(NAME_70_MB)] })],
  identities: [identity({ kind: 3, fields: [F.name(NAME_64_MB, true)] })],
  dir: 'informative/state',
});
stateVector({
  id: 'INF-LEN-2',
  testId: 'INF-LEN',
  normative: false,
  description: 'A symbol of 15 × "😀" (15 characters, 60 bytes) is truncated to its first 12 characters (48 bytes).',
  basis: LEN_BASIS,
  steps: [apply({ block: 1, recs: [R.symbol('😀'.repeat(15))] })],
  identities: [identity({ kind: 3, fields: [F.symbol('😀'.repeat(12), true)] })],
  dir: 'informative/state',
});
const SYM_AA = 'ACMEACMEACME-AA';
const SYM_BB = 'ACMEACMEACME-BB';
stateVector({
  id: 'INF-LEN-3',
  testId: 'INF-LEN',
  normative: false,
  description: `Grouping compares the stored symbol: kinds 1 and 3 of 0x11 with "${SYM_AA}" and kind 1 of 0x22 with "${SYM_BB}" are all served as "ACMEACMEACME", but form two groups ("${SYM_AA}" with two members, "${SYM_BB}" alone).`,
  basis: LEN_BASIS,
  steps: [
    apply({ block: 1, event: 0, domainSep: D11, kind: 1, recs: [R.symbol(SYM_AA)] }),
    apply({ block: 1, event: 1, domainSep: D11, kind: 3, recs: [R.symbol(SYM_AA)] }),
    apply({ block: 1, event: 2, domainSep: D22, kind: 1, recs: [R.symbol(SYM_BB)] }),
  ],
  identities: [
    identity({ domainSep: D11, kind: 1, fields: [F.symbol('ACMEACMEACME', true)] }),
    identity({ domainSep: D11, kind: 3, fields: [F.symbol('ACMEACMEACME', true)] }),
    identity({ domainSep: D22, kind: 1, fields: [F.symbol('ACMEACMEACME', true)] }),
  ],
  groups: [
    group(NET_A, CONTRACT_A, SYM_AA, [
      [D11, 1],
      [D11, 3],
    ]),
    group(NET_A, CONTRACT_A, SYM_BB, [[D22, 1]]),
  ],
  dir: 'informative/state',
});

// ---- image content (MIP "Common fields": "When image_sha256 is set, consumers MUST NOT display content from image
// whose SHA-256 differs from it. Without image_sha256, the content cannot be checked") ----
const IMG_BASIS =
  'MIP "Common fields": "When image_sha256 is set, consumers MUST NOT display content from image whose SHA-256 differs from it. Without image_sha256, the content cannot be checked." This repository reads a set image_sha256 of another length (unusable) as one no content matches, and leaves unchecked content to the consumer (allowed).';
stateVector({
  id: 'INF-IMG-1',
  testId: 'INF-IMG',
  normative: false,
  description:
    'An image_sha256 of 31 bytes is set but unusable: no SHA-256 equals it, so no content from image is displayed, not even the content whose first 31 hash bytes match.',
  basis: IMG_BASIS,
  steps: [apply({ block: 1, recs: [R.image(IMAGE_URI), R.imageSha256(IMAGE_SHA256_31)] })],
  identities: [identity({ kind: 3, fields: [field('image', URI, IMAGE_URI, true), field('image_sha256', BYTES, IMAGE_SHA256_31, false)] })],
  images: [image({ kind: 3, content: IMAGE_CONTENT, displayable: false })],
  dir: 'informative/state',
});
stateVector({
  id: 'INF-IMG-2',
  testId: 'INF-IMG',
  normative: false,
  description: 'Without image_sha256 the content cannot be checked; the reference consumer allows it (unchecked).',
  basis: IMG_BASIS,
  steps: [apply({ block: 1, recs: [R.image(IMAGE_URI)] })],
  identities: [identity({ kind: 3, fields: [field('image', URI, IMAGE_URI, true)] })],
  images: [image({ kind: 3, content: IMAGE_OTHER, displayable: true })],
  dir: 'informative/state',
});

// ---- zero extension (MIP "Consuming": missing trailing bytes are zero; name 32, payload 256) ----
// Each vector gives the name and/or payload as a source that drops trailing zero bytes returns it (raw ledger data,
// the Compact runtime), and expects exactly the decision and records of the full form, built by the same construction
// as the normative vector it trims. Plus the two longer cases: a 257-byte payload and a 33-byte name.
const ZEXT_BASIS =
  'MIP "Consuming": "Some sources drop trailing zero bytes; consumers MUST treat missing trailing bytes as zero, so that every `name` is 32 bytes and every `payload` 256 bytes, before decoding." The expected result is the full form\'s.';
const ZEXT_DIR = 'informative/zero-extension';
/** The bytes without their trailing zero bytes, as such a source returns them. */
function trimZeros(b: Bytes): Bytes {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.slice(0, end);
}
const NAME_V1_TRIMMED = trimZeros(NAME_V1);
check(NAME_V1_TRIMMED.length === 27, 'the v1 name has 5 trailing zero bytes');
function zextAccept(id: string, description: string, full: Built, recs: Rec[], ev: { name: Bytes; payload: Bytes }): void {
  payloadVector({
    id,
    testId: 'INF-ZEXT',
    normative: false,
    description,
    basis: ZEXT_BASIS,
    name: ev.name,
    payload: ev.payload,
    expect: {
      result: 'accept',
      header: { domainSep: toHex(full.bytes.subarray(0, 32)), kind: full.bytes[32] },
      records: recs.map((r, i) => recordJson(r, full.offsets[i] as number)),
      contentEnd: full.contentEnd,
    },
    dir: ZEXT_DIR,
  });
}
const zextReject = (id: string, description: string, ev: { name?: Bytes; payload: Bytes }, reason: string, offset: number) =>
  payloadVector({
    id,
    testId: 'INF-ZEXT',
    normative: false,
    description,
    basis: ZEXT_BASIS,
    name: ev.name ?? NAME_V1,
    payload: ev.payload,
    expect: { result: 'reject', reason, offset },
    dir: ZEXT_DIR,
  });
const A1_TRIMMED = trimZeros(A1.bytes);
check(A1_TRIMMED.length === 95, 'A1 without its padding is 95 bytes');
zextAccept('INF-ZEXT-1', "A1 with the payload's 161 trailing zero bytes dropped (95 bytes): accepted exactly as A1.", A1, A1_RECS, {
  name: NAME_V1,
  payload: A1_TRIMMED,
});
zextAccept('INF-ZEXT-2', "A1 with the name's 5 trailing zero bytes dropped (27 bytes): accepted exactly as A1.", A1, A1_RECS, {
  name: NAME_V1_TRIMMED,
  payload: A1.bytes,
});
zextAccept('INF-ZEXT-3', 'A1 with both the name (27 bytes) and the payload (95 bytes) trimmed: accepted exactly as A1.', A1, A1_RECS, {
  name: NAME_V1_TRIMMED,
  payload: A1_TRIMMED,
});
const A3B_RECS = [rec('data', BYTES, [0x01, 0x00, 0x00])];
const A3B = build(D11, 3, A3B_RECS);
const A3B_TRIMMED = trimZeros(A3B.bytes);
check(A3B_TRIMMED.length === 41, "A3b trimmed loses the value's two zero bytes");
zextAccept(
  'INF-ZEXT-4',
  'A3b trimmed (41 bytes): the value 01 00 00 is the last record, so trimming drops its two zero bytes too; zero extension restores them and the value is still 01 00 00 (value length 3), exactly as A3b.',
  A3B,
  A3B_RECS,
  { name: NAME_V1, payload: A3B_TRIMMED },
);
const R1_TRIMMED = trimZeros(cat(D11, [3]));
check(R1_TRIMMED.length === 33, 'R1 trimmed is the 33-byte header');
zextReject(
  'INF-ZEXT-5',
  'R1 trimmed (the 33-byte header alone): zero-extended it is R1 and is rejected the same way (no records).',
  { payload: R1_TRIMMED },
  'no-records',
  33,
);
zextReject(
  'INF-ZEXT-6',
  'An empty payload with the v1 name: zero-extended it is 256 zero bytes, so kind is 0 and the event is rejected.',
  { payload: EMPTY },
  'bad-kind',
  32,
);
zextReject(
  'INF-ZEXT-7',
  'A 257-byte payload (A1 followed by one more zero byte): longer than 256 bytes, so it cannot be decoded as defined in the MIP and the event is rejected.',
  { payload: cat(A1.bytes, [0]) },
  'bad-payload-length',
  0,
);
payloadVector({
  id: 'INF-ZEXT-8',
  testId: 'INF-ZEXT',
  normative: false,
  description:
    'A 33-byte name (the v1 name followed by one more zero byte) with the A1 payload: not the 32-byte v1 name, so the event is ignored ("any other name").',
  basis: `${ZEXT_BASIS} Zero extension only adds missing bytes; a longer name is another name (MIP "Event": consumers MUST ignore Misc events with any other name).`,
  name: cat(NAME_V1, [0]),
  payload: A1.bytes,
  expect: { result: 'ignore', reason: 'other-name' },
  dir: ZEXT_DIR,
});
stateVector({
  id: 'INF-ZEXT-S1',
  testId: 'INF-ZEXT',
  normative: false,
  description:
    'Reducer: A1, then name = "Beta", both observed with the name and payload trimmed: the identity has name "Beta" and A1\'s other three fields, exactly as with the full forms.',
  basis: ZEXT_BASIS,
  steps: [
    apply({ block: 1, name: NAME_V1_TRIMMED, payload: A1_TRIMMED }),
    apply({ block: 2, name: NAME_V1_TRIMMED, payload: trimZeros(build(D11, 3, [R.name('Beta')]).bytes) }),
  ],
  identities: [
    identity({
      kind: 3,
      fields: [F.name('Beta', true), F.symbol('ACME', true), F.decimals(6, true), F.standards('mip-0004', true)],
    }),
  ],
  dir: ZEXT_DIR,
});

// ===============================================================================================================
// Manifest, sums, write / check
// ===============================================================================================================

const counts: Record<string, number> = {};
for (const m of manifest) {
  const key = `${m.normative ? 'normative' : 'informative'}-${m.kind}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
counts.total = manifest.length;
emit(
  MANIFEST_FILE,
  json({
    format: FORMAT,
    mip: { id: MIP.id, repository: MIP.repository, commit: MIP.commit, path: MIP.path, sha256: MIP.sha256, url: MIP.url, pr: MIP.pr },
    eventName: { text: 'mip-0018:token-metadata[v1]', hex: toHex(NAME_V1) },
    generator: GENERATOR,
    counts,
    vectors: manifest,
  }),
);

/** Folders the generator owns completely (stale files there are an error / are removed). */
const GENERATED_DIRS = ['payload', 'state', 'informative/payload', 'informative/state', 'informative/zero-extension'];
function isGeneratedPath(rel: string): boolean {
  if (GENERATED_DIRS.some((d) => rel.startsWith(`${d}/`))) return true;
  return /^informative\/uri\/[^/]+$/.test(rel) && rel !== 'informative/uri/README.md';
}

function contentFor(rel: string, base: string): Uint8Array {
  const generated = outputs.get(rel);
  if (generated !== undefined) return generated;
  return readFileSync(join(base, rel)); // static pinned file (schemas, URI investigation data, READMEs)
}

function sumsText(base: string): string {
  const pinned = new Set<string>([MANIFEST_FILE]);
  for (const root of PINNED_ROOTS) for (const rel of listFiles(root, base)) if (!isGeneratedPath(rel)) pinned.add(rel);
  for (const rel of outputs.keys()) pinned.add(rel);
  return [...pinned]
    .sort()
    .map((rel) => `${sha256Hex(contentFor(rel, base))}  ${rel}`)
    .join('\n')
    .concat('\n');
}

function run(): number {
  const checkOnly = process.argv.includes('--check');
  const base = VECTORS_DIR;
  const sums = sumsText(base);
  const all = new Map(outputs);
  all.set(SUMS_FILE, utf8(sums));
  const stale = PINNED_ROOTS.flatMap((r) => listFiles(r, base)).filter((rel) => isGeneratedPath(rel) && !outputs.has(rel));
  if (checkOnly) {
    const problems: string[] = [];
    for (const [rel, data] of all) {
      let disk: Uint8Array;
      try {
        disk = readFileSync(join(base, rel));
      } catch {
        problems.push(`missing: ${rel}`);
        continue;
      }
      if (Buffer.compare(Buffer.from(disk), Buffer.from(data)) !== 0) problems.push(`differs: ${rel}`);
    }
    for (const rel of stale) problems.push(`stale (not generated): ${rel}`);
    if (problems.length > 0) {
      console.error(`vectors --check: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  ${p}`);
      return 1;
    }
    console.log(
      `vectors --check: OK — ${manifest.length} vectors (${JSON.stringify(counts)}), ${all.size} generated files byte-equal, SHA256SUMS current`,
    );
    return 0;
  }
  for (const rel of stale) rmSync(join(base, rel));
  for (const [rel, data] of all) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), data);
  }
  console.log(`vectors: wrote ${all.size} files (${manifest.length} vectors: ${JSON.stringify(counts)}); removed ${stale.length} stale`);
  return 0;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`generator self-check failed: ${message}`);
}

process.exitCode = run();
