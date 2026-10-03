// SPDX-License-Identifier: Apache-2.0
//
// Network endpoints. Stagenet values are pinned (toolchain.json); the local
// stack's come from docker/local-stack/ports.env through the environment.
// The chain clients themselves live in @mip0018/midnight; `toProfile` /
// `toEndpoints` map this spike configuration onto them.

import { STAGENET as PINNED, stagenetProfile, undeployedProfile, type NetworkProfile } from '@mip0018/midnight';
import type { SignerEndpoints } from '@mip0018/midnight/signer';

export type NetworkConfig = {
  readonly name: 'local' | 'stagenet';
  readonly networkId: string;
  readonly indexer: string;
  readonly indexerWs: string;
  readonly node: string;
  readonly nodeWs: string;
  readonly proofServer: string;
  /** Proof server the wallet uses for DUST spends (defaults to proofServer). */
  readonly walletProofServer: string;
  /** Expected genesis hash (chain_getBlockHash(0)); undefined for a fresh local chain. */
  readonly genesisHash?: string;
};

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
};

const toWs = (url: string) => url.replace(/^http/u, 'ws');

export const STAGENET_GENESIS = PINNED.genesisHash;

export const stagenet = (): NetworkConfig => ({
  name: 'stagenet',
  networkId: 'stagenet',
  indexer: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
  indexerWs: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
  node: 'https://rpc.stagenet.shielded.tools',
  nodeWs: 'wss://rpc.stagenet.shielded.tools',
  proofServer: env('MIP0018_PROOF_SERVER_URL'),
  walletProofServer: env('MIP0018_WALLET_PROOF_SERVER_URL', env('MIP0018_PROOF_SERVER_URL')),
  genesisHash: STAGENET_GENESIS,
});

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
    walletProofServer: env('MIP0018_WALLET_PROOF_SERVER_URL', 'http://wallet-proof-server:6300'),
  };
};

/** The package's network profile + signer endpoints for a spike NetworkConfig. */
export const toProfile = (n: NetworkConfig): NetworkProfile =>
  n.name === 'stagenet'
    ? stagenetProfile({ indexer: n.indexer, indexerWs: n.indexerWs, rpc: n.node, rpcWs: n.nodeWs })
    : undeployedProfile({ indexer: n.indexer, indexerWs: n.indexerWs, rpc: n.node, rpcWs: n.nodeWs });

export const toEndpoints = (n: NetworkConfig): SignerEndpoints => ({
  profile: toProfile(n),
  proofServer: n.proofServer,
  walletProofServer: n.walletProofServer,
});
