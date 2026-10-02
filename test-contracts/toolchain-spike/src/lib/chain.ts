// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free chain reads used before and after every transaction (Q13 (b)):
// node RPC, indexer GraphQL (v4) and the proof server's health endpoints.

import { ContractState } from '@midnightntwrk/ledger-v9';
import type { NetworkConfig } from './network.js';

export const rpc = async <T>(network: NetworkConfig, method: string, params: unknown[] = []): Promise<T> => {
  const res = await fetch(network.node, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined || body.result === undefined) {
    throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result;
};

export const graphql = async <T>(network: NetworkConfig, query: string, variables: Record<string, unknown> = {}): Promise<T> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(network.indexer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`indexer HTTP ${res.status}`);
      const body = (await res.json()) as { data?: T; errors?: unknown };
      if (body.errors !== undefined) throw new Error(`indexer GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)));
    }
  }
  throw last;
};

export type Block = { height: number; hash: string; timestamp: number };

export const latestBlock = async (network: NetworkConfig): Promise<Block> =>
  (await graphql<{ block: Block }>(network, 'query { block { height hash timestamp } }')).block;

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
  const out: MiscEvent[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await graphql<{ contractEvents: MiscEvent[] }>(
      network,
      `query ($filter: ContractEventFilter!, $offset: Int!) {
        contractEvents(filter: $filter, limit: 500, offset: $offset) {
          id contractAddress raw
          ... on MiscContractEvent { name payload }
          transaction { hash block { height hash } }
        }
      }`,
      { filter: { contractAddress, types: ['MISC'], ...(transactionHash ? { transactionHash } : {}) }, offset },
    );
    out.push(...page.contractEvents);
    if (page.contractEvents.length < 500) break;
  }
  return out.sort((a, b) => a.id - b.id);
};

export type ContractView = { exists: boolean; operations: string[]; blockHeight?: number; transactionHash?: string };

/** The contract's latest on-chain state as the indexer sees it: which entry points have verifier keys. */
export const contractView = async (network: NetworkConfig, contractAddress: string): Promise<ContractView> => {
  const data = await graphql<{ contractAction: null | { state: string; transaction: { hash: string; block: { height: number } } } }>(
    network,
    `query ($address: HexEncoded!) { contractAction(address: $address) { state transaction { hash block { height } } } }`,
    { address: contractAddress },
  );
  if (!data.contractAction) return { exists: false, operations: [] };
  const state = ContractState.deserialize(Buffer.from(data.contractAction.state, 'hex'));
  const operations = state
    .operations()
    .map((op) => (typeof op === 'string' ? op : Buffer.from(op).toString('utf8')))
    .filter((op) => {
      try {
        const vk = state.operation(op)?.verifierKey;
        return vk !== undefined && vk.length > 0;
      } catch {
        return false; // an entry point left without any verifier key
      }
    })
    .sort();
  return {
    exists: true,
    operations,
    blockHeight: data.contractAction.transaction.block.height,
    transactionHash: data.contractAction.transaction.hash,
  };
};

export type TransactionView =
  | { hash: string; status?: string; fee?: string; block: { height: number; hash: string } }
  | undefined;

export const transactionByHash = async (network: NetworkConfig, hash: string): Promise<TransactionView> => {
  const data = await graphql<{
    transactions: { hash: string; block: { height: number; hash: string }; fee?: string; transactionResult?: { status: string } }[];
  }>(
    network,
    `query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) {
        hash block { height hash } ... on RegularTransaction { fee transactionResult { status } } } }`,
    { hash },
  );
  const t = data.transactions[0];
  return t ? { hash: t.hash, status: t.transactionResult?.status, fee: t.fee, block: t.block } : undefined;
};

/** Polls until `check` returns a value (bounded). */
export const waitFor = async <T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 180_000, everyMs = 3_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
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
  const genesisHash = await rpc<string>(network, 'chain_getBlockHash', [0]);
  if (network.genesisHash && genesisHash !== network.genesisHash) {
    throw new Error(`wrong chain: genesis ${genesisHash}, expected ${network.genesisHash}`);
  }
  const nodeVersion = await rpc<string>(network, 'system_version');
  const runtime = await rpc<{ specVersion: number }>(network, 'state_getRuntimeVersion');
  const finalizedHead = await rpc<string>(network, 'chain_getFinalizedHead');
  const finalizedHeader = await rpc<{ number: string }>(network, 'chain_getHeader', [finalizedHead]);
  const tip = await latestBlock(network);
  const health = await fetch(`${network.proofServer}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`proof server /health: HTTP ${health.status}`);
  const proofServerVersion = (await (await fetch(`${network.proofServer}/version`)).text()).trim();
  const proofVersions = (await (await fetch(`${network.proofServer}/proof-versions`)).text()).trim();
  const walletProofServerVersion = (await (await fetch(`${network.walletProofServer}/version`, { signal: AbortSignal.timeout(10_000) })).text()).trim();
  return {
    network: network.name,
    networkId: network.networkId,
    genesisHash,
    nodeVersion,
    specVersion: runtime.specVersion,
    finalizedHeight: Number(finalizedHeader.number),
    indexerHeight: tip.height,
    indexerHash: tip.hash,
    proofServerVersion,
    proofVersions,
    walletProofServerVersion,
    checkedAt: new Date().toISOString(),
  };
};
