// SPDX-License-Identifier: Apache-2.0
//
// Network endpoints of the local stack: from docker/local-stack/ports.env through the environment. The chain clients
// themselves live in @mip0018/midnight; `toProfile` / `toEndpoints` map this spike configuration onto them.

import { undeployedProfile, type NetworkProfile } from '@mip0018/midnight';
import type { SignerEndpoints } from '@mip0018/midnight/signer';

export type NetworkConfig = {
  readonly name: 'local';
  readonly networkId: string;
  readonly indexer: string;
  readonly indexerWs: string;
  readonly node: string;
  readonly nodeWs: string;
  /** The proof server: contract circuits and the wallet's DUST spends. */
  readonly proofServer: string;
  /** Expected genesis hash (chain_getBlockHash(0)); undefined for a fresh local chain. */
  readonly genesisHash?: string;
};

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
};

const toWs = (url: string) => url.replace(/^http/u, 'ws');

/** The local stack, reached from a container on its Docker network. */
export const local = (): NetworkConfig => {
  const indexer = env('MIP0018_INDEXER_URL', 'http://indexer:8088/api/v4/graphql');
  const node = env('MIP0018_NODE_URL', 'http://node:9944');
  return {
    name: 'local',
    networkId: 'undeployed',
    indexer,
    indexerWs: `${toWs(indexer)}/ws`,
    node,
    nodeWs: toWs(node),
    proofServer: env('MIP0018_PROOF_SERVER_URL', 'http://proof-server:6300'),
  };
};

/** The package's network profile + signer endpoints for a spike NetworkConfig. */
export const toProfile = (n: NetworkConfig): NetworkProfile =>
  undeployedProfile({ indexer: n.indexer, indexerWs: n.indexerWs, rpc: n.node, rpcWs: n.nodeWs });

export const toEndpoints = (n: NetworkConfig): SignerEndpoints => ({
  profile: toProfile(n),
  proofServer: n.proofServer,
});
