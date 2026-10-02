// SPDX-License-Identifier: Apache-2.0
//
// mip0018 adapter for SpikeOzToken (OpenZeppelin 0.4.0-alpha.5 `Ownable` + `NativeShieldedToken`).
//
// OZ `Ownable` authenticates the caller with the witness `wit_OwnableSK()` (a 32-byte secret); the owner id stored
// at construction is `persistentHash<Vector<1, Bytes<32>>>([secret])` (OZ `Utils.computeAccountId`). At deploy this
// adapter creates a fresh secret as the contract's private state — it is written only to the signer's 0600
// private-state file (before the deploy is submitted) and never to the public run record. A different signer with
// a different private state is not the owner, so its `publishMetadata` / `mint` calls fail before submission.
//
//   --args '["0x<domainSep>", "<name>", "<symbol>", <decimals>]'      constructor
//   publishMetadata: [{"$utf8": "<name, ≤ 10 bytes>"}, {"$utf8": "<symbol, ≤ 4 bytes>"}]
//   mint: [{"bytes": "0x<coin public key>"}, <amount>, "0x<nonce>"]

import { randomBytes } from 'node:crypto';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import type { ContractAdapter } from '@mip0018/midnight/signer';

type OwnerState = { ownerSecret: Uint8Array };

const hex = (v: unknown, n: number): Uint8Array => {
  const h = String(v).replace(/^0x/u, '');
  if (!new RegExp(`^[0-9a-fA-F]{${2 * n}}$`, 'u').test(h)) throw new Error(`expected ${n} bytes of hex, got ${String(v)}`);
  return Uint8Array.from(Buffer.from(h, 'hex'));
};

export const ownerId = (secret: Uint8Array): Uint8Array => persistentHash(new CompactTypeVector(1, new CompactTypeBytes(32)), [secret]);

export const adapter: ContractAdapter<OwnerState> = {
  contract: { name: 'SpikeOzToken', managedDir: 'managed/SpikeOzToken' },
  compile: { workspace: 'test-contracts/toolchain-spike', script: 'compile' },
  witnesses: {
    wit_OwnableSK: ({ privateState }: { privateState: OwnerState }): [OwnerState, Uint8Array] => [privateState, privateState.ownerSecret],
  },
  privateStateId: 'SpikeOzToken',
  initialPrivateState: () => ({ ownerSecret: Uint8Array.from(randomBytes(32)) }),
  constructorArgs: (json, ctx) => {
    const [domainSep, name, symbol, decimals] = json as [string, string, string, number];
    if (!ctx.privateState) throw new Error('SpikeOzToken needs its owner private state');
    return [
      hex(domainSep, 32),
      String(name),
      String(symbol),
      BigInt(decimals),
      { is_left: true, left: ownerId(ctx.privateState.ownerSecret), right: { bytes: new Uint8Array(32) } },
    ];
  },
};
