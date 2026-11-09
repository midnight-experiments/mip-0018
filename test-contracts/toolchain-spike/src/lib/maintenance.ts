// SPDX-License-Identifier: Apache-2.0
//
// VerifierKeyRemove from @mip0018/midnight/signer: Compact 0.36.0 circuits are ZKIR v3, whose verifier keys live in
// the 'v4' slot.

import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { SigningKey } from '@midnightntwrk/ledger-v9';
import { currentContractState, removeVerifierKey as removePackage } from '@mip0018/midnight/signer';
import { toProfile, type NetworkConfig } from './network.js';

export const describeOperation = async (network: NetworkConfig, address: string, circuit: string): Promise<string | undefined> =>
  (await currentContractState(toProfile(network), address)).operation(circuit)?.toString(true);

export const removeVerifierKey = (
  providers: MidnightProviders,
  network: NetworkConfig,
  address: string,
  circuit: string,
  signingKey: SigningKey,
  version: 'v3' | 'v4' = 'v4',
) => removePackage(providers, toProfile(network), address, circuit, signingKey, version);
