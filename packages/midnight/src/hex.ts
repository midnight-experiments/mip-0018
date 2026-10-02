// SPDX-License-Identifier: Apache-2.0
//
// Hex helpers. The indexer's `HexEncoded` scalar is lowercase hex WITHOUT `0x`; node RPC hashes carry `0x`.
// Everything this package returns is lowercase hex without `0x` unless a function says otherwise.

export class HexError extends Error {
  override name = 'HexError';
}

/** Lowercase, `0x` stripped, validated (even length, hex digits only). */
export function normHex(value: string, what = 'hex value'): string {
  const h = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(h)) throw new HexError(`${what} is not an even-length hex string`);
  return h.toLowerCase();
}

/** `normHex` that also checks the byte length. */
export function normHexBytes(value: string, bytes: number, what = 'hex value'): string {
  const h = normHex(value, what);
  if (h.length !== bytes * 2) throw new HexError(`${what} must be ${bytes} bytes (${bytes * 2} hex digits), got ${h.length / 2}`);
  return h;
}

/**
 * MIP "Consuming": "Some sources drop trailing zero bytes; consumers MUST treat missing trailing bytes as zero, so that
 * every `name` is 32 bytes and every `payload` 256 bytes, before decoding." Normalizes the hex and zero-extends it to
 * `bytes`; a longer value is returned unchanged (classification then ignores the name or rejects the payload).
 */
export function zeroExtendHex(value: string, bytes: number, what = 'hex value'): string {
  const h = normHex(value, what);
  return h.length < bytes * 2 ? h.padEnd(bytes * 2, '0') : h;
}

export function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(normHex(value), 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** Contract addresses on ledger v9 are 32 bytes. */
export const CONTRACT_ADDRESS_BYTES = 32;

export function normAddress(value: string, what = 'contract address'): string {
  return normHexBytes(value, CONTRACT_ADDRESS_BYTES, what);
}

/** Transaction hashes are 32 bytes. */
export function normTxHash(value: string, what = 'transaction hash'): string {
  return normHexBytes(value, 32, what);
}

/** `0x` + lowercase hex, for node RPC parameters. */
export function to0x(value: string): string {
  return `0x${normHex(value)}`;
}

/** JSON replacer that writes bigints as decimal strings and byte arrays as hex. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

export function toJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, jsonReplacer, indent);
}
