// SPDX-License-Identifier: Apache-2.0
//
// Token colors (MIP-0018 "Terminology", "Lookup"): `color = tokenType(domainSep, contractAddress)`, the Compact
// standard library's
//
//   tokenType(domain_sep, contractAddress) = persistentCommit<Vector<2, Bytes<32>>>([domain_sep, contractAddress.bytes],
//                                                                                     pad(32, "midnight:derive_token"))
//
// computed here with ledger-v9's `rawTokenType` (the same Rust code the ledger runs). The same 32 bytes are the color
// of the shielded (kind 1) and the unshielded (kind 2) representation; kind 3 (ledger tokens) never has a color.
// A color MUST always be computed, never read from a value.
//
// `tokenTypeSha256` is an independent implementation (SHA-256 over opening ‖ domainSep ‖ address, per
// `persistent_commit` in midnight-ledger base-crypto) used only to cross-check the binding in tests.

import { createHash } from 'node:crypto';
import { rawTokenType } from '@midnightntwrk/ledger-v9';
import { bytesToHex, hexToBytes, normAddress } from './hex.ts';

export class ColorError extends Error {
  override name = 'ColorError';
}

const DERIVE_TOKEN = (() => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode('midnight:derive_token'));
  return b;
})();

function checkDomainSep(domainSep: Uint8Array | string): Uint8Array {
  const ds = typeof domainSep === 'string' ? hexToBytes(domainSep) : domainSep;
  if (ds.length !== 32) throw new ColorError(`domainSep must be 32 bytes, got ${ds.length}`);
  return Uint8Array.from(ds);
}

/** `tokenType(domainSep, contractAddress)` as lowercase hex (64 digits). */
export function tokenTypeHex(domainSep: Uint8Array | string, contractAddress: Uint8Array | string): string {
  const addr = typeof contractAddress === 'string' ? normAddress(contractAddress) : normAddress(bytesToHex(contractAddress));
  return String(rawTokenType(checkDomainSep(domainSep), addr)).toLowerCase();
}

/** `tokenType(domainSep, contractAddress)` as 32 bytes — the shape `@mip0018/consumer` expects for its hook. */
export function tokenType(domainSep: Uint8Array, contractAddress: Uint8Array): Uint8Array {
  return hexToBytes(tokenTypeHex(domainSep, contractAddress));
}

/** Independent SHA-256 implementation (tests only). */
export function tokenTypeSha256(domainSep: Uint8Array | string, contractAddress: Uint8Array | string): string {
  const addr = typeof contractAddress === 'string' ? hexToBytes(normAddress(contractAddress)) : contractAddress;
  return createHash('sha256').update(DERIVE_TOKEN).update(checkDomainSep(domainSep)).update(addr).digest('hex');
}
