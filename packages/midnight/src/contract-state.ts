// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free view of a deployed contract's state (indexer `contractAction.state`, decoded with ledger-v9): which
// entry points currently have a verifier key — e.g. to confirm a create-and-destroy removal. The network identity
// (genesis; block 1 when the profile names a chain instance) is checked before the state is read.

import { ContractState } from '@midnightntwrk/ledger-v9';
import type { Indexer } from './indexer.ts';
import { checkIdentity, httpFor, indexerFor, type NetworkProfile } from './network.ts';

/** Entry points of the contract that currently have a verifier key, or null when the contract is unknown. */
export async function contractOperations(profile: NetworkProfile, address: string, indexer?: Indexer): Promise<string[] | null> {
  const idx = indexer ?? indexerFor(profile, httpFor(profile));
  await checkIdentity(profile, idx.http);
  const s = await idx.contractState(address);
  if (!s) return null;
  return ContractState.deserialize(Buffer.from(s.state, 'hex'))
    .operations()
    .map((op) => (typeof op === 'string' ? op : Buffer.from(op).toString('utf8')))
    .sort();
}
