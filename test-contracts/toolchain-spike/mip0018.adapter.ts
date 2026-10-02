// SPDX-License-Identifier: Apache-2.0
//
// mip0018 adapter for SpikeEmitter (the S0 smallest emitter): no constructor arguments, no witnesses; its single
// unguarded `publishMetadata()` emits the MIP-0018 A1 payload. Used by
// `mip0018 deploy-and-publish --example toolchain-spike [--metadata <A1 metadata>]` (create-and-destroy then
// `mip0018 remove-circuit --circuit publishMetadata`).

import type { ContractAdapter } from '@mip0018/midnight/signer';

export const adapter: ContractAdapter = {
  contract: { name: 'SpikeEmitter', managedDir: 'managed/SpikeEmitter' },
  compile: { workspace: 'test-contracts/toolchain-spike', script: 'compile' },
  deployArgs: () => [],
  publish: () => [{ circuit: 'publishMetadata', args: [] }],
};
