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
 * MIP's Appendix A, and the 26 URI verdicts against the two independent grammars of the F1 investigation.
 */
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
  tombstone: (key: string = 'retire') => rec(key, NULL, EMPTY),
};

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
  /** `null` = hidden (tombstoned): no fields. */
  fields: FieldDef[] | null;
  colored?: boolean;
}

function identity(d: IdDef): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const f of d.fields ?? []) {
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
    visible: d.fields !== null,
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
  dir?: string;
}

function stateVector(d: StateDef): void {
  claimId(d.id);
  const dir = d.dir ?? 'state';
  const normative = d.normative ?? true;
  const v: Record<string, unknown> = { id: d.id, mip: { commit: MIP.commit, testId: d.testId }, normative, description: d.description };
  if (d.basis !== undefined) v.basis = d.basis;
  v.steps = d.steps;
  const expect: Record<string, unknown> = { identities: d.identities };
  if (d.groups !== undefined) expect.groups = d.groups;
  if (d.display !== undefined) expect.display = d.display;
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
  id: 'A3c',
  testId: 'A3',
  description: 'Exact bytes: a non-UTF-8 key (ff 6b 65 79) is accepted.',
  recs: [rec([0xff, 0x6b, 0x65, 0x79], UTF8, 'ok')],
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
  description: 'Exact bytes (state): the A3a event gives one identity two fields, "symbol" = "ACME" and "symbol\\0" = "ZZZ".',
  steps: [apply({ block: 1, recs: [R.symbol('ACME'), rec(cat(utf8('symbol'), [0x00]), UTF8, 'ZZZ')] })],
  identities: [identity({ kind: 3, fields: [F.symbol('ACME', true), field(cat(utf8('symbol'), [0x00]), UTF8, 'ZZZ')] })],
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
stateVector({
  id: 'A5a-state',
  testId: 'A5',
  description: 'Non-tombstones (state): after name = "Acme" and an empty string at "note", the identity is visible with both fields.',
  steps: [apply({ block: 1, recs: A5A_RECS })],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), field('note', UTF8, EMPTY)] })],
});
stateVector({
  id: 'A5b-state',
  testId: 'A5',
  description: 'Non-tombstones (state): after name = "Acme" and empty bytes at "blob", the identity is visible with both fields.',
  steps: [apply({ block: 1, recs: A5B_RECS })],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), field('blob', BYTES, EMPTY)] })],
});
stateVector({
  id: 'A5c-state',
  testId: 'A5',
  description: 'Non-tombstones (state): after name = "Acme" and JSON null at "meta", the identity is visible with both fields.',
  steps: [apply({ block: 1, recs: A5C_RECS })],
  identities: [identity({ kind: 3, fields: [F.name('Acme', true), field('meta', JSON_T, 'null')] })],
});

// S1 — order within an event
stateVector({
  id: 'S1a',
  testId: 'S1',
  description:
    'Order within an event: for kind 1, name = "A" (33), Null at key "retire" (41), name = "B" (50) leave the identity visible with only name = "B".',
  steps: [apply({ block: 1, kind: 1, recs: [R.name('A'), R.tombstone('retire'), R.name('B')], offsets: [33, 41, 50] })],
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

// S3 — tombstone
const S3_K1_RECS = [R.name('Gold'), R.symbol('GLD'), R.decimals(6), R.standards('mip-0011')];
const S3_K3_RECS = [R.name('Gold'), R.symbol('GLD'), R.decimals(6), R.standards('mip-0004')];
const S3_K1_FIELDS = [F.name('Gold', true), F.symbol('GLD', true), F.decimals(6, true), F.standards('mip-0011', true)];
const S3_K3_FIELDS = [F.name('Gold', true), F.symbol('GLD', true), F.decimals(6, true), F.standards('mip-0004', true)];
const S3_PUBLISH = [apply({ block: 1, event: 0, kind: 1, recs: S3_K1_RECS }), apply({ block: 1, event: 1, kind: 3, recs: S3_K3_RECS })];
const S3_TOMBSTONE_K1 = (block: number) => apply({ block, kind: 1, recs: [R.tombstone('retire')] });
stateVector({
  id: 'S3a',
  testId: 'S3',
  description:
    'Tombstone: name/symbol/decimals/standards for kinds 1 and 3 under one domainSep (block 1), then a Null record for kind 1 (block 2): kind 1 is hidden with all fields cleared; kind 3 is unchanged.',
  steps: [...S3_PUBLISH, S3_TOMBSTONE_K1(2)],
  identities: [identity({ kind: 1, fields: null }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S3b',
  testId: 'S3',
  description: 'Tombstone: a second Null record for kind 1 (block 3) changes nothing.',
  steps: [...S3_PUBLISH, S3_TOMBSTONE_K1(2), S3_TOMBSTONE_K1(3)],
  identities: [identity({ kind: 1, fields: null }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S3c',
  testId: 'S3',
  description:
    'Tombstone: after both Nulls, a kind-1 name = "New" (block 4) makes kind 1 visible with only name; standards reads as empty (no field) and nothing from before the tombstone returns.',
  steps: [...S3_PUBLISH, S3_TOMBSTONE_K1(2), S3_TOMBSTONE_K1(3), apply({ block: 4, kind: 1, recs: [R.name('New')] })],
  identities: [identity({ kind: 1, fields: [F.name('New', true)] }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S3d',
  testId: 'S3',
  description: 'Tombstone: a Null record at key "name" for kind 1 (block 2) withdraws the whole identity, not only name.',
  steps: [...S3_PUBLISH, apply({ block: 2, kind: 1, recs: [rec('name', NULL, EMPTY)] })],
  identities: [identity({ kind: 1, fields: null }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});

// S4 — reorganization
stateVector({
  id: 'S4a',
  testId: 'S4',
  description: 'Reorganization: S3a, then block 2 (the tombstone block) is removed: the earlier state of kind 1 is restored.',
  steps: [...S3_PUBLISH, S3_TOMBSTONE_K1(2), rollback(NET_A, 1)],
  identities: [identity({ kind: 1, fields: S3_K1_FIELDS }), identity({ kind: 3, fields: S3_K3_FIELDS })],
});
stateVector({
  id: 'S4b',
  testId: 'S4',
  description: 'Reorganization: S4a, then the tombstone block is added again: kind 1 is withdrawn again.',
  steps: [...S3_PUBLISH, S3_TOMBSTONE_K1(2), rollback(NET_A, 1), S3_TOMBSTONE_K1(2)],
  identities: [identity({ kind: 1, fields: null }), identity({ kind: 3, fields: S3_K3_FIELDS })],
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
  ledgerHidden?: boolean;
}
function s9Identities(o: S9Opts = {}): Array<Record<string, unknown>> {
  return [
    identity({ domainSep: D11, kind: 1, fields: [F.name('Acme Shielded', true), F.symbol('ACME', true)] }),
    identity({
      domainSep: D11,
      kind: 3,
      fields: o.ledgerHidden ? null : [F.name(o.ledgerName ?? 'Acme Ledger', true), F.symbol('ACME', true)],
    }),
    identity({ domainSep: D22, kind: 1, fields: [F.name('Acme Two', true), F.symbol(o.twoSymbol ?? 'ACME', true)] }),
    identity({ contract: CONTRACT_B, domainSep: D11, kind: 1, fields: [F.name('Other Contract', true), F.symbol('ACME', true)] }),
    identity({ domainSep: D33, kind: 3, fields: [F.name('Lower Case', true), F.symbol('acme', true)] }),
    identity({ domainSep: D44, kind: 3, fields: [F.name('Leading Space', true), F.symbol(' ACME', true)] }),
    identity({ domainSep: D55, kind: 3, fields: [F.name('Bytes Symbol', true), field('symbol', BYTES, 'ACME', false)] }),
    identity({ domainSep: D66, kind: 3, fields: [F.name('Upper Key', true), field('SYMBOL', UTF8, 'ACME')] }),
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
  description: `Symbol grouping: ${S9_SETUP} Kinds 1 and 3 of 0x11 and kind 1 of 0x22 form one group; the other contract, the other network, "acme" and " ACME" are separate groups; the type-0 symbol, the key "SYMBOL" and the missing symbol are ungrouped.`,
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
  description: 'Symbol grouping: after S9a, a tombstone for the kind-3 member removes it from the group.',
  steps: [...S9_BASE, apply({ block: 2, domainSep: D11, kind: 3, recs: [R.tombstone('retire')] })],
  identities: s9Identities({ ledgerHidden: true }),
  groups: [
    group(NET_A, CONTRACT_A, 'ACME', [
      [D11, 1],
      [D22, 1],
    ]),
    ...S9_OTHER_GROUPS,
  ],
});

// ===============================================================================================================
// Informative vectors (normative = false)
// ===============================================================================================================

// ---- URI cases (owner ruling Q20: RFC 3986 `URI` rule as ERC-721 uses it; proposal note N1) ----
// Verdicts transcribed from the F1 investigation and cross-checked below against both independent grammars.
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
    'Owner ruling Q20 (follow ERC-721: RFC 3986 `URI`), proposal note N1. Verdict = strict RFC 3986 grammar (investigation/rfc3986.mjs) = Python rfc3987 rule URI (investigation/py.json); they agree on 26/26.';
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
  json({ rule: 'RFC 3986 URI (scheme required, fragment allowed, ASCII only)', basis: 'Q20 / N1', cases: uriVerdicts }),
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
const N5_BASIS = `${STD_BASIS} The byte rule allows other Unicode spaces and controls (U+00A0, U+0085); the project withdrew the note asking the MIP to say so (N6, out of scope).`;
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
    'MIP "Common fields": name/symbol = UTF-8 string, not empty; decimals = unsigned integer; a field without that type or form is unusable.',
  steps: [apply({ block: 1, recs: [rec('name', BYTES, 'Acme'), rec('symbol', UTF8, EMPTY), rec('decimals', BYTES, [0x06])] })],
  identities: [
    identity({
      kind: 3,
      fields: [field('name', BYTES, 'Acme', false), field('symbol', UTF8, EMPTY, false), field('decimals', BYTES, [0x06], false)],
    }),
  ],
  dir: 'informative/state',
});

// ---- zero extension (MIP "Consuming", 78ecbb4: missing trailing bytes are zero; name 32, payload 256) ----
// Each vector gives the name and/or payload as a source that drops trailing zero bytes returns it (raw ledger data,
// the Compact runtime), and expects exactly the decision and records of the full form, built by the same construction
// as the normative vector it trims. Plus the two longer cases: a 257-byte payload and a 33-byte name.
const ZEXT_BASIS =
  'MIP "Consuming" (78ecbb4): "Some sources drop trailing zero bytes; consumers MUST treat missing trailing bytes as zero, so that every `name` is 32 bytes and every `payload` 256 bytes, before decoding." The expected result is the full form\'s.';
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
    'Reducer: A1, then name = "Beta", both observed with the name and payload trimmed: the identity is visible with name "Beta" and A1\'s other three fields, exactly as with the full forms.',
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
const GENERATED_DIRS = ['payload', 'state', 'informative/state', 'informative/zero-extension'];
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
