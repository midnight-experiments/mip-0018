// SPDX-License-Identifier: Apache-2.0
// The two contracts of the upgrade template, how to build them, and their shared witness.
//
//   legacy/LegacyToken.compact            the deployed token (no MIP-0018 circuit)
//   upgrade/LegacyTokenMetadata.compact   upgrade-only source: the same ledger layout + publishMetadata()
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import { ensureCompiled } from '@mip0018/compact/testing';

export const EXAMPLE_DIR = join(import.meta.dirname, '..');
export const MANAGED_DIR = join(EXAMPLE_DIR, 'managed');
const MODULE_DIR = join(EXAMPLE_DIR, '..', '..', 'packages', 'compact', 'src');

export const LEGACY = { name: 'LegacyToken', source: join(EXAMPLE_DIR, 'legacy', 'LegacyToken.compact') } as const;
export const UPGRADE = {
  name: 'LegacyTokenMetadata',
  source: join(EXAMPLE_DIR, 'upgrade', 'LegacyTokenMetadata.compact'),
} as const;
export const CONTRACTS = { [LEGACY.name]: LEGACY, [UPGRADE.name]: UPGRADE } as const;
export type ContractName = keyof typeof CONTRACTS;

export const managedDirOf = (name: ContractName) => join(MANAGED_DIR, name);

/** Compiles one of the two sources into managed/<name> if needed (TypeScript only unless skipZk: false). */
export const compile = (name: ContractName, o: { skipZk?: boolean; force?: boolean } = {}): string =>
  ensureCompiled(CONTRACTS[name].source, managedDirOf(name), {
    skipZk: o.skipZk ?? true,
    force: o.force ?? false,
    dependsOn: name === UPGRADE.name ? [MODULE_DIR] : [],
  });

/** The metadata publishMetadata() emits (literals in the upgrade source; domainSep read from the ledger). */
export const PUBLISHED = { kind: 1, name: 'Legacy Token', symbol: 'LGCY', decimals: 6 } as const;

/** Private state of both contracts: the owner's secret (read by the `ownerSecret` witness). */
export type OwnerState = { ownerSecret: Uint8Array };

export const witnesses = {
  ownerSecret: ({ privateState }: { privateState: OwnerState }): [OwnerState, Uint8Array] => [privateState, privateState.ownerSecret],
};

export const freshOwnerState = (): OwnerState => ({ ownerSecret: Uint8Array.from(randomBytes(32)) });

const pad32 = (s: string): Uint8Array => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s));
  return b;
};

/** LegacyToken's ownerId: persistentHash<Vector<2, Bytes<32>>>([pad(32, "legacy-token:owner"), secret]). */
export const ownerId = (secret: Uint8Array): Uint8Array =>
  persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [pad32('legacy-token:owner'), secret]);

/** 32 bytes from hex (with or without 0x). */
export const hex32 = (v: unknown, what = 'value'): Uint8Array => {
  const h = String(v).replace(/^0x/u, '');
  if (!/^[0-9a-fA-F]{64}$/u.test(h)) throw new Error(`${what}: expected 32 bytes of hex, got ${String(v)}`);
  return Uint8Array.from(Buffer.from(h, 'hex'));
};
