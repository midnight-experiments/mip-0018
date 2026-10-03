// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free view of a deployed contract's state (indexer `contractAction.state`, decoded with ledger-v9): which
// entry points currently have a verifier key — e.g. to confirm a create-and-destroy removal.

import { ContractState } from '@midnightntwrk/ledger-v9';
import { Indexer } from './indexer.ts';
import type { NetworkProfile } from './network.ts';

/** Entry points of the contract that currently have a verifier key, or null when the contract is unknown. */
export async function contractOperations(profile: NetworkProfile, address: string, indexer?: Indexer): Promise<string[] | null> {
  const s = await (indexer ?? new Indexer(profile.indexer, profile.indexerWs)).contractState(address);
  if (!s) return null;
  return ContractState.deserialize(Buffer.from(s.state, 'hex'))
    .operations()
    .map((op) => (typeof op === 'string' ? op : Buffer.from(op).toString('utf8')))
    .sort();
}
