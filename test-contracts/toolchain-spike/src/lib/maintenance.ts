// SPDX-License-Identifier: Apache-2.0
//
// VerifierKeyRemove for circuits compiled with --feature-zkir-v3 (Q23) — promoted to @mip0018/midnight/signer (S4).
// midnight-js 5.0.0-rc.2 builds maintenance updates for the 'v3' key slot only; ZKIR v3 keys live in 'v4'.

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
