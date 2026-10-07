// Payload encoding: header ‖ records ‖ zero padding (MIP "Payload"). The encoder only produces payloads a conforming
// consumer accepts: it validates the header, every record and the total size before writing anything.
import { DOMAIN_SEP_SIZE, IMAGE_SHA256_SIZE, KIND_OFFSET, PAYLOAD_SIZE, RECORDS_OFFSET, ValType } from './constants.ts';
import type { Header, MetadataRecord } from './decode.ts';
import { checkValue, decodeUtf8, encodeUint, minimalUintWidth } from './values.ts';

/** The records do not fit in 256 bytes. */
export class PayloadTooLarge extends Error {
  override name = 'PayloadTooLarge';
  /** Bytes the header and records would need. */
  readonly size: number;
  constructor(size: number) {
    super(`payload needs ${size} bytes; the maximum is ${PAYLOAD_SIZE}`);
    this.size = size;
  }
}

/** A record (or the record list) breaks a MIP rule. */
export class InvalidRecord extends Error {
  override name = 'InvalidRecord';
  /** Index of the offending record, or -1 for the list as a whole. */
  readonly index: number;
  constructor(index: number, message: string) {
    super(index >= 0 ? `record ${index}: ${message}` : message);
    this.index = index;
  }
}

/** The header breaks a MIP rule (domainSep not 32 bytes, kind not 1/2/3). */
export class InvalidHeader extends Error {
  override name = 'InvalidHeader';
}

/** Encodes a payload. Throws `InvalidHeader`, `InvalidRecord` or `PayloadTooLarge`. */
export function encodePayload(header: Header, records: readonly MetadataRecord[]): Uint8Array {
  if (!(header.domainSep instanceof Uint8Array) || header.domainSep.length !== DOMAIN_SEP_SIZE)
    throw new InvalidHeader('domainSep must be 32 bytes');
  if (header.kind !== 1 && header.kind !== 2 && header.kind !== 3)
    throw new InvalidHeader(`kind must be 1, 2 or 3, got ${String(header.kind)}`);
  if (records.length === 0) throw new InvalidRecord(-1, 'at least one record is required');
  let size = RECORDS_OFFSET;
  records.forEach((r, i) => {
    if (!(r.key instanceof Uint8Array) || r.key.length < 1 || r.key.length > 255) throw new InvalidRecord(i, 'key must be 1-255 bytes');
    if (decodeUtf8(r.key) === undefined) throw new InvalidRecord(i, 'key must be valid UTF-8');
    if (!(r.value instanceof Uint8Array) || r.value.length > 255) throw new InvalidRecord(i, 'value must be 0-255 bytes');
    if (!Number.isInteger(r.valType) || r.valType < 0 || r.valType > 5)
      throw new InvalidRecord(i, `valType must be 0-5, got ${String(r.valType)}`);
    const bad = checkValue(r.valType, r.value);
    if (bad !== undefined) throw new InvalidRecord(i, `value breaks its type rule (${bad})`);
    size += 3 + r.key.length + r.value.length;
  });
  if (size > PAYLOAD_SIZE) throw new PayloadTooLarge(size);

  const out = new Uint8Array(PAYLOAD_SIZE);
  out.set(header.domainSep, 0);
  out[KIND_OFFSET] = header.kind;
  let at = RECORDS_OFFSET;
  for (const r of records) {
    out[at] = r.key.length;
    out.set(r.key, at + 1);
    out[at + 1 + r.key.length] = r.valType;
    out[at + 2 + r.key.length] = r.value.length;
    out.set(r.value, at + 3 + r.key.length);
    at += 3 + r.key.length + r.value.length;
  }
  return out;
}

/** Size in bytes a list of records takes after the header. */
export function recordsSize(records: readonly MetadataRecord[]): number {
  return records.reduce((n, r) => n + 3 + r.key.length + r.value.length, 0);
}

const utf8 = (s: string | Uint8Array): Uint8Array => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

/** Record constructors. Keys given as strings are UTF-8 encoded. */
export const record = {
  bytes: (key: string | Uint8Array, value: Uint8Array): MetadataRecord => ({ key: utf8(key), valType: ValType.Bytes, value }),
  utf8: (key: string | Uint8Array, text: string): MetadataRecord => ({ key: utf8(key), valType: ValType.Utf8, value: utf8(text) }),
  /** Unsigned integer; `width` defaults to the smallest that holds the value (1 byte for `decimals`, like `Uint<8>`). */
  uint: (key: string | Uint8Array, value: bigint | number, width?: number): MetadataRecord => ({
    key: utf8(key),
    valType: ValType.UInt,
    value: encodeUint(value, width ?? minimalUintWidth(value)),
  }),
  /** JSON text, stored as given (not re-serialised). */
  json: (key: string | Uint8Array, text: string): MetadataRecord => ({ key: utf8(key), valType: ValType.Json, value: utf8(text) }),
  uri: (key: string | Uint8Array, uri: string): MetadataRecord => ({ key: utf8(key), valType: ValType.Uri, value: utf8(uri) }),
  /** `image` = a URI (type 4): the token's image or logo (MIP "Common fields"). */
  image: (uri: string): MetadataRecord => ({ key: utf8('image'), valType: ValType.Uri, value: utf8(uri) }),
  /** `image_sha256` = the 32-byte SHA-256 of the file at `image` (type 0). Throws `RangeError` for any other length. */
  imageSha256: (hash: Uint8Array): MetadataRecord => {
    if (!(hash instanceof Uint8Array) || hash.length !== IMAGE_SHA256_SIZE)
      throw new RangeError(`image_sha256 must be ${IMAGE_SHA256_SIZE} bytes`);
    return { key: utf8('image_sha256'), valType: ValType.Bytes, value: hash.slice() };
  },
  /**
   * A Null record (tombstone) at `key`: deletes that field (MIP "Applying records"). To withdraw a token, emit a Null
   * record for each of its keys in one event — `withdrawRecords()` for the six common keys.
   */
  tombstone: (key: string | Uint8Array): MetadataRecord => ({ key: utf8(key), valType: ValType.Null, value: new Uint8Array(0) }),
};

/** The six common keys of MIP "Common fields", in the order `withdrawRecords()` deletes them. */
export const COMMON_KEY_TEXTS = ['name', 'symbol', 'decimals', 'standards', 'image', 'image_sha256'] as const;

/**
 * Withdraws a token: Null records at `name`, `symbol`, `decimals`, `standards`, `image` and `image_sha256`, in that
 * order (62 bytes, content ends at offset 95; the same records as the Compact module's `withdraw(domainSep, kind)`).
 * A token identity exists only while one of its fields has a value, so once every key it has is deleted consumers do
 * not reference it. A Null record for a field without a value has no effect. A token with keys beyond the common six
 * (keys a declared standard defines) adds a Null record for each of them (`[...withdrawRecords(), record.tombstone('k')]`).
 */
export function withdrawRecords(): MetadataRecord[] {
  return COMMON_KEY_TEXTS.map((key) => record.tombstone(key));
}

/**
 * The common fields as records, in the order `name`, `symbol`, `decimals` (as `Uint<8>`), `standards`, `image`,
 * `image_sha256`; only the ones given.
 */
export function commonRecords(fields: {
  name?: string;
  symbol?: string;
  decimals?: number | bigint;
  standards?: string | readonly string[];
  image?: string;
  imageSha256?: Uint8Array;
}): MetadataRecord[] {
  const out: MetadataRecord[] = [];
  if (fields.name !== undefined) out.push(record.utf8('name', fields.name));
  if (fields.symbol !== undefined) out.push(record.utf8('symbol', fields.symbol));
  if (fields.decimals !== undefined) out.push(record.uint('decimals', fields.decimals, 1));
  if (fields.standards !== undefined)
    out.push(record.utf8('standards', typeof fields.standards === 'string' ? fields.standards : fields.standards.join(' ')));
  if (fields.image !== undefined) out.push(record.image(fields.image));
  if (fields.imageSha256 !== undefined) out.push(record.imageSha256(fields.imageSha256));
  return out;
}
