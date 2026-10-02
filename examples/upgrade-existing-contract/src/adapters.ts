// SPDX-License-Identifier: Apache-2.0
//
// mip0018 adapters (packages/midnight/src/signer/adapter.ts) for the two contracts of the upgrade template.
//
// LegacyToken authenticates its owner with the witness `ownerSecret()`; the owner id stored at construction is
// ownerId(secret). At deploy the legacy adapter creates a fresh secret as the contract's private state: it is written
// only to the signer's 0600 private-state file (before the deploy is submitted), never to the public run record.
// The upgrade's publishMetadata() checks the same owner through the same witness, so it reads the SAME private
// state (stored under the deployed contract's address and privateStateId "LegacyToken").
//
//   deploy:  --args '["0x<domainSep>"]'
//   mint:    --args '[{"bytes": "0x<coin public key>"}, <amount>, "0x<nonce, 32 bytes>"]'
//   upgrade: mip0018 upgrade --record <legacy record> --source examples/upgrade-existing-contract/upgrade --circuit publishMetadata
import type { ContractAdapter } from '@mip0018/midnight/signer';
import { freshOwnerState, hex32, ownerId, witnesses, type OwnerState } from './contracts.ts';

const PRIVATE_STATE_ID = 'LegacyToken';

export const legacyAdapter: ContractAdapter<OwnerState> = {
  contract: { name: 'LegacyToken', managedDir: '../managed/LegacyToken' },
  compile: { workspace: 'examples/upgrade-existing-contract', script: 'compile' },
  witnesses,
  privateStateId: PRIVATE_STATE_ID,
  initialPrivateState: freshOwnerState,
  constructorArgs: (json, ctx) => {
    const [domainSep] = json as [string];
    if (!ctx.privateState) throw new Error('LegacyToken needs its owner private state');
    return [hex32(domainSep, 'domainSep'), ownerId(ctx.privateState.ownerSecret)];
  },
};

export const upgradeAdapter: ContractAdapter<OwnerState> = {
  contract: { name: 'LegacyTokenMetadata', managedDir: '../managed/LegacyTokenMetadata' },
  compile: { workspace: 'examples/upgrade-existing-contract', script: 'compile' },
  witnesses,
  privateStateId: PRIVATE_STATE_ID,
  // A signer without the owner's private state gets a fresh secret: the owner check then fails locally and
  // nothing is submitted (as for any other non-owner call).
  initialPrivateState: freshOwnerState,
};
