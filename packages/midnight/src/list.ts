// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free "all metadata of a contract" (spec FR-042).
//
//  1. identity check (node genesis), then pin the snapshot: the indexer tip {height, hash} (finalized: the indexer
//     ingests finalized blocks only) cross-checked with the node (`chain_getBlockHash(height)`), `toBlock` =
//     min(--to-block, tip)
//  2. page `contractEvents(filter:{contractAddress, types:[MISC], toBlock}, limit 500, offset)` until an EMPTY page
//     (a server that silently caps the page size cannot truncate the list); refuse above --max-events
//  3. chain order: (block height, transaction id, event id); exact-name filter and decoding by the reference consumer
//     (`@mip0018/consumer`), which applies records (tombstones, latest wins, usability, groups); colors for kinds
//     1 and 2 come from ledger-v9 `rawTokenType` injected into the consumer

import { MetadataState, type IdentityView, type SymbolGroup } from '@mip0018/consumer';
import { hexToBytes, normAddress, normHex } from './hex.ts';
import { HttpClient } from './http.ts';
import { Indexer, type IndexedMiscEvent } from './indexer.ts';
import { checkIdentity, type NetworkProfile } from './network.ts';
import { NodeRpc } from './rpc.ts';
import { tokenType } from './color.ts';
import { classify } from './verify.ts';

export interface ListedEvent {
  id: number;
  block: { height: number; hash: string };
  txHash: string;
  txId: number;
  result: 'accept' | 'reject' | 'ignore';
  reason?: string;
  identity?: string;
  domainSep?: string;
  kind?: number;
  records?: number;
}

export interface ListReport {
  network: { id: string; genesisHash: string; indexer: string };
  contract: string;
  snapshot: {
    indexerTip: { height: number; hash: string };
    toBlock: number;
    nodeHashAtTip: string | null;
    tipMatchesNode: boolean;
    finalizedHeight: number;
  };
  pages: number;
  counts: { events: number; accepted: number; rejected: number; ignored: number };
  events: ListedEvent[];
  identities: IdentityView[];
  groups: SymbolGroup[];
  history?: Record<string, Record<string, unknown[]>>;
}

export interface ListOptions {
  profile: NetworkProfile;
  contract: string;
  toBlock?: number;
  history?: boolean;
  maxEvents?: number;
  http?: HttpClient;
}

/** Applies indexer events (any order) to a fresh consumer state in chain order. */
export function reduceEvents(
  network: string,
  evs: IndexedMiscEvent[],
  keepHistory = false,
): { state: MetadataState; listed: ListedEvent[] } {
  const state = new MetadataState({ tokenType, keepHistory });
  const sorted = [...evs].sort(
    (a, b) => a.transaction.block.height - b.transaction.block.height || a.transaction.id - b.transaction.id || a.id - b.id,
  );
  const listed: ListedEvent[] = [];
  for (const e of sorted) {
    const name = normHex(e.name ?? '');
    const payload = normHex(e.payload ?? '');
    const base = { id: e.id, block: e.transaction.block, txHash: e.transaction.hash, txId: e.transaction.id };
    if (name.length !== 64 || payload.length !== 512) {
      listed.push({ ...base, result: 'ignore', reason: 'undecodable-misc-data' });
      continue;
    }
    const r = state.apply({
      network,
      contractAddress: normHex(e.contractAddress),
      block: e.transaction.block.height,
      tx: e.transaction.id,
      event: e.id,
      type: 'Misc',
      name: hexToBytes(name),
      payload: hexToBytes(payload),
    });
    if (r.result === 'accept') {
      const c = classify(name, payload);
      listed.push({ ...base, result: 'accept', identity: r.identity, domainSep: c.domainSep, kind: c.kind, records: r.records });
    } else listed.push({ ...base, result: r.result, reason: r.reason });
  }
  return { state, listed };
}

export async function listMetadata(o: ListOptions): Promise<ListReport> {
  const contract = normAddress(o.contract);
  const http = o.http ?? new HttpClient({ minIntervalMs: o.profile.minIntervalMs });
  const indexer = new Indexer(o.profile.indexer, o.profile.indexerWs, http);
  const rpc = new NodeRpc(o.profile.rpc, http);
  const genesis = await checkIdentity(o.profile, http);
  const tip = await indexer.latestBlock();
  const toBlock = o.toBlock === undefined ? tip.height : Math.min(o.toBlock, tip.height);
  const nodeHash = await rpc.blockHash(tip.height);
  const fin = await rpc.finalizedHead();
  const { events, pages } = await indexer.allContractEvents(contract, { toBlock }, { maxEvents: o.maxEvents });
  const { state, listed } = reduceEvents(o.profile.id, events, o.history ?? false);
  const identities = state.identities();
  const report: ListReport = {
    network: { id: o.profile.id, genesisHash: genesis, indexer: o.profile.indexer },
    contract,
    snapshot: {
      indexerTip: { height: tip.height, hash: tip.hash },
      toBlock,
      nodeHashAtTip: nodeHash,
      tipMatchesNode: nodeHash === `0x${normHex(tip.hash)}`,
      finalizedHeight: fin.height,
    },
    pages,
    counts: {
      events: listed.length,
      accepted: listed.filter((e) => e.result === 'accept').length,
      rejected: listed.filter((e) => e.result === 'reject').length,
      ignored: listed.filter((e) => e.result === 'ignore').length,
    },
    events: listed,
    identities,
    groups: state.groups(),
  };
  if (o.history) {
    report.history = {};
    for (const id of identities) {
      const h: Record<string, unknown[]> = {};
      for (const f of id.fields) {
        const entries = state.history(id.key, f.keyHex);
        if (entries.length > 0) h[f.keyHex] = entries;
      }
      report.history[id.key] = h;
    }
  }
  return report;
}

/** Reduces the MIP-0018 events a scan recorded for one contract (lookup without a live query). */
export function reduceScannedEvents(
  network: string,
  contractAddress: string,
  evs: { block: { height: number }; txIndex: number; eventIndex: number; name: string; payload: string }[],
): MetadataState {
  const state = new MetadataState({ tokenType });
  const sorted = [...evs].sort((a, b) => a.block.height - b.block.height || a.txIndex - b.txIndex || a.eventIndex - b.eventIndex);
  for (const e of sorted) {
    state.apply({
      network,
      contractAddress: normAddress(contractAddress),
      block: e.block.height,
      tx: e.txIndex,
      event: e.eventIndex,
      type: 'Misc',
      name: hexToBytes(e.name),
      payload: hexToBytes(e.payload),
    });
  }
  return state;
}
