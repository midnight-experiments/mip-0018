// SPDX-License-Identifier: Apache-2.0
//
// mip0018 CLI adapter for the TEST-ONLY raw emitter (NOT FOR PRODUCTION): OpenZeppelin `Ownable`; the deployer's
// fresh 32-byte secret is the private state (signer's 0600 file only), the constructor's owner is
// `left(persistentHash<Vector<1, Bytes<32>>>([secret]))`. Used for the negative, ignore and capacity cases:
//
//   mip0018 deploy  --example raw-emitter --record <file>
//   mip0018 publish --record <file> --circuit emitRaw --args @<[name hex, payload hex]> --step <vector id> --force
//   mip0018 publish --record <file> --circuit emitTwo --args @<[name1, payload1, name2, payload2]> --step S7b --force
//
// (`--force`: a deliberate re-emission of accepted bytes is never skipped; negative events never are anyway.)

import { randomBytes } from 'node:crypto';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import type { ContractAdapter } from '@mip0018/midnight/signer';
import { ownerArg, witnesses, type RawEmitterPrivateState } from './src/contract.ts';

const accountId = (sk: Uint8Array): Uint8Array => persistentHash(new CompactTypeVector(1, new CompactTypeBytes(32)), [sk]);

export const adapter: ContractAdapter<RawEmitterPrivateState> = {
  contract: { name: 'RawEmitter', managedDir: 'managed/RawEmitter' },
  compile: { workspace: 'test-contracts/raw-emitter', script: 'compile', args: ['--keys'] },
  witnesses,
  privateStateId: 'RawEmitter',
  initialPrivateState: () => ({ ownableSecretKey: Uint8Array.from(randomBytes(32)) }),
  deployArgs: () => [],
  constructorArgs: (json, ctx) => {
    if (json.length !== 0) throw new Error('RawEmitter takes no constructor arguments (the owner is the deployer)');
    if (!ctx.privateState) throw new Error('RawEmitter needs its owner private state');
    return [ownerArg(accountId(ctx.privateState.ownableSecretKey))];
  },
};
