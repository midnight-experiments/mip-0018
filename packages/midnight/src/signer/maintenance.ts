// SPDX-License-Identifier: Apache-2.0
//
// Maintenance updates for circuits compiled with --feature-zkir-v3 (question Q23).
//
// midnight-js 5.0.0-rc.2 / compact-js 3.0.0-rc.3 build every maintenance update with ContractOperationVersion 'v3'
// (the ZKIR v2 key slot), so `circuitMaintenanceTx.<circuit>.removeVerifierKey()` cannot remove a ZKIR v3 key, which
// the ledger keeps in the 'v4' slot: the update is included but its fallible segment fails. These helpers build the
// same signed MaintenanceUpdate with the version given and submit it through midnight-js `submitTx` (proof provider +
// wallet balancing + submission), exactly like the SDK path. `insertVerifierKey` is the same for S6's upgrade.

import { submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import {
  ContractOperationVersion,
  ContractOperationVersionedVerifierKey,
  ContractState,
  Intent,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyInsert,
  VerifierKeyRemove,
  signData,
  type SigningKey,
} from '@midnightntwrk/ledger-v9';
import { Indexer } from '../indexer.ts';
import type { NetworkProfile } from '../network.ts';

export type KeySlot = 'v3' | 'v4';

export const currentContractState = async (profile: NetworkProfile, address: string): Promise<ContractState> => {
  const s = await new Indexer(profile.indexer, profile.indexerWs).contractState(address);
  if (!s) throw new Error(`contract ${address} not found`);
  return ContractState.deserialize(Buffer.from(s.state, 'hex'));
};

/** Entry points that currently have a verifier key (any slot). */
export const operationsWithKey = (state: ContractState): string[] =>
  state
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

const submitUpdate = async (
  providers: MidnightProviders,
  profile: NetworkProfile,
  address: string,
  signingKey: SigningKey,
  build: (counter: bigint) => MaintenanceUpdate,
) => {
  const state = await currentContractState(profile, address);
  const update = build(state.maintenanceAuthority.counter);
  const signed = update.addSignature(0n, signData(signingKey, update.dataToSign));
  const intent = Intent.new(new Date(Date.now() + 30 * 60_000)).addMaintenanceUpdate(signed);
  const unprovenTx = Transaction.fromParts(profile.networkId, undefined, undefined, intent);
  return submitTx(providers as never, { unprovenTx } as never);
};

export const removeVerifierKey = (
  providers: MidnightProviders,
  profile: NetworkProfile,
  address: string,
  circuit: string,
  signingKey: SigningKey,
  slot: KeySlot = 'v4',
) =>
  submitUpdate(
    providers,
    profile,
    address,
    signingKey,
    (counter) => new MaintenanceUpdate(address, [new VerifierKeyRemove(circuit, new ContractOperationVersion(slot))], counter),
  );

export const insertVerifierKey = (
  providers: MidnightProviders,
  profile: NetworkProfile,
  address: string,
  circuit: string,
  verifierKey: Uint8Array,
  signingKey: SigningKey,
  slot: KeySlot = 'v4',
) =>
  submitUpdate(
    providers,
    profile,
    address,
    signingKey,
    (counter) =>
      new MaintenanceUpdate(
        address,
        [new VerifierKeyInsert(circuit, new ContractOperationVersionedVerifierKey(slot, verifierKey))],
        counter,
      ),
  );
