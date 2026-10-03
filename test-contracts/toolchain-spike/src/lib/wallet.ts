// SPDX-License-Identifier: Apache-2.0
//
// Wallet SDK 2.0.0-beta.2 wiring for midnight-js 5.0.0-rc.2, from @mip0018/midnight/signer; these spike helpers are
// thin wrappers with the spike's own signatures. Never prints or stores seeds or keys.

import {
  closeWallet,
  describeWallet,
  midnightJsProviders,
  openWallet as openPackageWallet,
  waitForDust,
  waitForSync,
  type PublicIdentity,
  type WalletSession,
} from '@mip0018/midnight/signer';
import { toEndpoints, type NetworkConfig } from './network.js';

export type { PublicIdentity, WalletSession };
export { closeWallet, midnightJsProviders, waitForDust, waitForSync };

/** Opens the wallet of a BIP-32 master seed: account 0, index 0, roles Zswap / NightExternal / Dust. */
export const openWallet = (network: NetworkConfig, masterSeed: Uint8Array): Promise<WalletSession> =>
  openPackageWallet(toEndpoints(network), masterSeed);

export const describe = describeWallet;
