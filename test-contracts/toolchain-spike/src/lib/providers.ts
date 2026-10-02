// SPDX-License-Identifier: Apache-2.0
//
// midnight-js 5.0.0-rc.2 providers for a compiled contract directory.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WebSocket } from 'ws';
import type { NetworkConfig } from './network.js';
import { filePrivateStateProvider } from './private-state.js';
import { midnightJsProviders, type WalletSession } from './wallet.js';

/** Directory of a compiled spike contract (compactc output). */
export const managedDir = (contract: string) => join(import.meta.dirname, '..', '..', 'managed', contract);

/** Loads a compiled contract without witnesses as a compact-js CompiledContract. */
export const loadCompiledContract = async (contract: string) => {
  const dir = managedDir(contract);
  const mod = (await import(pathToFileURL(join(dir, 'contract', 'index.js')).href)) as { Contract: new (...a: never[]) => never };
  return CompiledContract.make(contract, mod.Contract as never).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(dir as never),
  );
};

export const buildProviders = (
  network: NetworkConfig,
  session: WalletSession,
  contract: string,
  privateStatePath?: string,
): MidnightProviders => {
  setNetworkId(network.networkId);
  const zkConfigProvider = new NodeZkConfigProvider<string>(managedDir(contract));
  const { walletProvider, midnightProvider } = midnightJsProviders(session);
  return {
    privateStateProvider: filePrivateStateProvider(privateStatePath),
    publicDataProvider: indexerPublicDataProvider({
      queryURL: network.indexer,
      subscriptionURL: network.indexerWs,
      webSocket: WebSocket as never,
    }),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider, { timeout: 600_000 }),
    walletProvider,
    midnightProvider,
  };
};
