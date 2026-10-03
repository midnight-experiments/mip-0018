// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free chain reads used before and after every transaction. The clients live in @mip0018/midnight (indexer
// GraphQL v4, node RPC, before/after checks); these spike helpers are thin wrappers with the spike's own signatures.

import { HttpClient, Indexer, NodeRpc, checkIdentity, normHex, type BlockInfo } from '@mip0018/midnight';
import { contractView as packageContractView, pollFor } from '@mip0018/midnight/signer';
import { toProfile, type NetworkConfig } from './network.js';

export const rpc = async <T>(network: NetworkConfig, method: string, params: unknown[] = []): Promise<T> =>
  new NodeRpc(network.node).call<T>(method, params);

export const graphql = async <T>(network: NetworkConfig, query: string, variables: Record<string, unknown> = {}): Promise<T> =>
  new Indexer(network.indexer, network.indexerWs).query<T>(query, variables);

export type Block = BlockInfo;

export const latestBlock = async (network: NetworkConfig): Promise<Block> => new Indexer(network.indexer, network.indexerWs).latestBlock();

export type MiscEvent = {
  id: number;
  contractAddress: string;
  name: string;
  payload: string;
  raw: string;
  transaction: { hash: string; block: { height: number; hash: string } };
};

/** Every Misc event of a contract (optionally of one transaction), in indexer id order. */
export const miscEvents = async (network: NetworkConfig, contractAddress: string, transactionHash?: string): Promise<MiscEvent[]> => {
  const { events } = await new Indexer(network.indexer, network.indexerWs).allContractEvents(
    contractAddress,
    transactionHash ? { transactionHash } : {},
  );
  return events.map((e) => ({
    id: e.id,
    contractAddress: e.contractAddress,
    name: e.name,
    payload: e.payload,
    raw: e.raw,
    transaction: { hash: e.transaction.hash, block: e.transaction.block },
  }));
};

export type ContractView = { exists: boolean; operations: string[]; blockHeight?: number; transactionHash?: string };

/** The contract's latest on-chain state as the indexer sees it: which entry points have verifier keys. */
export const contractView = async (network: NetworkConfig, contractAddress: string): Promise<ContractView> => {
  const v = await packageContractView(toProfile(network), contractAddress);
  return v.exists
    ? { exists: true, operations: v.operations, blockHeight: v.block?.height, transactionHash: v.txHash }
    : { exists: false, operations: [] };
};

export type TransactionView = { hash: string; status?: string; fee?: string; block: { height: number; hash: string } } | undefined;

export const transactionByHash = async (network: NetworkConfig, hash: string): Promise<TransactionView> => {
  const t = await new Indexer(network.indexer, network.indexerWs).transactionByHash(normHex(hash));
  return t
    ? { hash: t.hash, status: t.transactionResult?.status, fee: t.fee, block: { height: t.block.height, hash: t.block.hash } }
    : undefined;
};

/** Polls until `check` returns a value (bounded). */
export const waitFor = async <T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 180_000, everyMs = 3_000): Promise<T> => {
  const v = await pollFor(check, timeoutMs, everyMs);
  if (v === undefined) throw new Error(`timed out waiting for ${what}`);
  return v;
};

export type Preflight = {
  network: string;
  networkId: string;
  genesisHash: string;
  nodeVersion: string;
  specVersion: number;
  finalizedHeight: number;
  indexerHeight: number;
  indexerHash: string;
  proofServerVersion: string;
  proofVersions: string;
  walletProofServerVersion: string;
  checkedAt: string;
};

export const preflight = async (network: NetworkConfig): Promise<Preflight> => {
  const http = new HttpClient({ timeoutMs: 10_000 });
  const genesisHash = await checkIdentity(toProfile(network), http);
  const node = new NodeRpc(network.node, http);
  const fin = await node.finalizedHead();
  const tip = await latestBlock(network);
  const health = await http.getText(`${network.proofServer}/health`);
  if (health.status !== 200) throw new Error(`proof server /health: HTTP ${health.status}`);
  return {
    network: network.name,
    networkId: network.networkId,
    genesisHash,
    nodeVersion: await node.systemVersion(),
    specVersion: (await node.runtimeVersion()).specVersion,
    finalizedHeight: fin.height,
    indexerHeight: tip.height,
    indexerHash: tip.hash,
    proofServerVersion: (await http.getText(`${network.proofServer}/version`)).text,
    proofVersions: (await http.getText(`${network.proofServer}/proof-versions`)).text,
    walletProofServerVersion: (await http.getText(`${network.walletProofServer}/version`)).text,
    checkedAt: new Date().toISOString(),
  };
};
