// SPDX-License-Identifier: Apache-2.0
//
// midnight-js 5.0.0-rc.2 providers for a compiled spike contract, from @mip0018/midnight/signer
// (bounded, retrying proof provider; file private state; wallet session).

import { join } from 'node:path';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import {
  buildProviders as buildPackageProviders,
  filePrivateStateProvider,
  loadCompiledContract as loadPackageContract,
} from '@mip0018/midnight/signer';
import { toEndpoints, type NetworkConfig } from './network.js';
import type { WalletSession } from './wallet.js';

/** Directory of a compiled spike contract (compactc output). */
export const managedDir = (contract: string) => join(import.meta.dirname, '..', '..', 'managed', contract);

/** Loads a compiled contract without witnesses as a compact-js CompiledContract. */
export const loadCompiledContract = (contract: string) => loadPackageContract({ name: contract, managedDir: managedDir(contract) });

export const buildProviders = (
  network: NetworkConfig,
  session: WalletSession,
  contract: string,
  privateStatePath?: string,
): MidnightProviders =>
  buildPackageProviders(
    toEndpoints(network),
    session,
    { name: contract, managedDir: managedDir(contract) },
    filePrivateStateProvider(privateStatePath),
  );
