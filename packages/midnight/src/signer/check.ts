// SPDX-License-Identifier: Apache-2.0
//
// Chain checks run before and after every transaction. They read the indexer only (wallet-free):
//
//   contractView      does the contract exist; which entry points have a verifier key
//   eventsInTx        the contract's Misc events in one transaction (in order)
//   wouldChange       would applying these MIP-0018 events change the contract's current metadata state?
//                     (the "expected fields already present" before-check of a publish)
//   transactionState  is a recorded transaction indexed, and how did it end

import { ContractState } from '@midnightntwrk/ledger-v9';
import { MetadataState } from '@mip0018/consumer';
import { hexToBytes, normHex } from '../hex.ts';
import { Indexer, type IndexedMiscEvent, type IndexedTransaction } from '../indexer.ts';
import { reduceEvents } from '../list.ts';
import type { NetworkProfile } from '../network.ts';
import { classify } from '../verify.ts';
import { operationsWithKey } from './maintenance.ts';

export interface ContractView {
  exists: boolean;
  operations: string[];
  block?: { height: number; hash: string };
  txHash?: string;
}

export const indexerFor = (p: NetworkProfile) => new Indexer(p.indexer, p.indexerWs);

export async function contractView(profile: NetworkProfile, address: string): Promise<ContractView> {
  const s = await indexerFor(profile).contractState(address);
  if (!s) return { exists: false, operations: [] };
  return {
    exists: true,
    operations: operationsWithKey(ContractState.deserialize(Buffer.from(s.state, 'hex'))),
    block: s.block,
    txHash: s.txHash,
  };
}

export async function eventsInTx(profile: NetworkProfile, address: string, txHash: string): Promise<IndexedMiscEvent[]> {
  const { events } = await indexerFor(profile).allContractEvents(address, { transactionHash: txHash });
  return events;
}

export async function transactionState(profile: NetworkProfile, txHash: string): Promise<IndexedTransaction | null> {
  return indexerFor(profile).transactionByHash(txHash);
}

/** Polls `check` until it returns a value or the time is up (undefined). */
export async function pollFor<T>(check: () => Promise<T | undefined>, timeoutMs: number, everyMs = 3_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() >= until) return undefined;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const snapshot = (s: MetadataState): string =>
  JSON.stringify(
    s
      .identities()
      .map((i) => ({
        key: i.key,
        fields: i.fields.map((f) => [f.keyHex, f.valType, Buffer.from(f.value).toString('hex')]).sort(),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  );

/**
 * Whether applying `next` (in order, after everything in `current`) changes the reduced metadata state. Returns
 * undefined when the check does not apply: one of `next` is not an ACCEPTED MIP-0018 event (malformed, other name —
 * those never change the state, so "no change" would wrongly skip a deliberate negative case).
 */
export function wouldChange(
  network: string,
  contractAddress: string,
  current: IndexedMiscEvent[],
  next: { name: string; payload: string }[],
): boolean | undefined {
  if (next.length === 0) return undefined;
  if (!next.every((e) => classify(normHex(e.name), normHex(e.payload)).result === 'accept')) return undefined;
  const { state } = reduceEvents(network, current);
  const before = snapshot(state);
  const top = current.reduce((m, e) => Math.max(m, e.transaction.block.height), 0) + 1;
  next.forEach((e, i) =>
    state.apply({
      network,
      contractAddress: normHex(contractAddress),
      block: top,
      tx: 0,
      event: i,
      type: 'Misc',
      name: hexToBytes(e.name),
      payload: hexToBytes(e.payload),
    }),
  );
  return snapshot(state) !== before;
}
