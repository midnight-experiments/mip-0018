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
  signatureVerifyingKey,
  type ContractMaintenanceAuthority,
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

/** The verifier key an entry point currently has (undefined: no operation or no key). */
export const onChainVerifierKey = (state: ContractState, circuit: string): Uint8Array | undefined => {
  try {
    const vk = state.operation(circuit)?.verifierKey;
    return vk !== undefined && vk.length > 0 ? vk : undefined;
  } catch {
    return undefined;
  }
};

export interface AuthorityCheck {
  ok: boolean;
  /** Why the key cannot sign alone (when !ok). */
  reason?: string;
  /** The key's index in the committee (the signature index), -1 when absent. */
  index: number;
  committeeSize: number;
  threshold: number;
  counter: string;
}

/**
 * Can `key` alone sign a maintenance update for a contract with this authority? (VerifierKeyInsert/Remove need the
 * authority's signatures and counter; MIP-0018 "Existing contracts".) Frozen authorities — an empty committee, the
 * ledger default, or a threshold above the committee size — can never sign anything.
 */
export function checkAuthority(authority: ContractMaintenanceAuthority, key: SigningKey): AuthorityCheck {
  const vk = signatureVerifyingKey(key);
  const committee = authority.committee;
  const index = committee.findIndex((c) => c.tag === vk.tag && c.value.toLowerCase() === vk.value.toLowerCase());
  const base = { index, committeeSize: committee.length, threshold: authority.threshold, counter: authority.counter.toString() };
  if (committee.length === 0)
    return {
      ...base,
      ok: false,
      reason:
        'the contract has a frozen maintenance authority (empty committee): no maintenance update can ever be signed; it cannot add a circuit (redeploy to adopt MIP-0018)',
    };
  if (authority.threshold > committee.length)
    return {
      ...base,
      ok: false,
      reason: `the authority's threshold ${authority.threshold} exceeds its committee (${committee.length} keys): it can never sign`,
    };
  if (index < 0)
    return {
      ...base,
      ok: false,
      reason: `this maintenance key is not in the contract's committee (${committee.length} key(s)); the node would reject the update`,
    };
  if (authority.threshold > 1)
    return {
      ...base,
      ok: false,
      reason: `the authority needs ${authority.threshold} signatures; this tool signs with one key (collect the others first)`,
    };
  return { ...base, ok: true };
}

const submitUpdate = async (
  providers: MidnightProviders,
  profile: NetworkProfile,
  address: string,
  signingKey: SigningKey,
  build: (counter: bigint) => MaintenanceUpdate,
  signatureIndex = 0n,
) => {
  const state = await currentContractState(profile, address);
  const update = build(state.maintenanceAuthority.counter);
  const signed = update.addSignature(signatureIndex, signData(signingKey, update.dataToSign));
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
  signatureIndex = 0n,
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
    signatureIndex,
  );
