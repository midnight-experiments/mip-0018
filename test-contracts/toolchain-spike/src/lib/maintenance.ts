// SPDX-License-Identifier: Apache-2.0
//
// VerifierKeyRemove for circuits compiled with --feature-zkir-v3.
//
// midnight-js 5.0.0-rc.2 / compact-js 3.0.0-rc.3 build every maintenance update
// with ContractOperationVersion 'v3' (the zk-stdlib v1 / ZKIR v2 key slot), so
// `circuitMaintenanceTx.<circuit>.removeVerifierKey()` cannot remove a ZKIR v3
// key, which the ledger keeps in the 'v4' slot: the update is included but its
// fallible segment fails. This helper builds the same signed MaintenanceUpdate
// with the version passed in, and submits it through midnight-js `submitTx`
// (proof provider + wallet balancing), exactly like the SDK path.

import { submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import {
  ContractOperationVersion,
  ContractState,
  Intent,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyRemove,
  signData,
  type SigningKey,
} from '@midnightntwrk/ledger-v9';
import { graphql } from './chain.js';
import type { NetworkConfig } from './network.js';

const currentState = async (network: NetworkConfig, address: string) => {
  const data = await graphql<{ contractAction: null | { state: string } }>(
    network,
    'query ($address: HexEncoded!) { contractAction(address: $address) { state } }',
    { address },
  );
  if (!data.contractAction) throw new Error(`contract ${address} not found`);
  return ContractState.deserialize(Buffer.from(data.contractAction.state, 'hex'));
};

export const describeOperation = async (network: NetworkConfig, address: string, circuit: string): Promise<string | undefined> => {
  const op = (await currentState(network, address)).operation(circuit);
  return op?.toString(true);
};

export const removeVerifierKey = async (
  providers: MidnightProviders,
  network: NetworkConfig,
  address: string,
  circuit: string,
  signingKey: SigningKey,
  version: 'v3' | 'v4' = 'v4',
) => {
  const state = await currentState(network, address);
  const counter = state.maintenanceAuthority.counter;
  const update = new MaintenanceUpdate(address, [new VerifierKeyRemove(circuit, new ContractOperationVersion(version))], counter);
  const signed = update.addSignature(0n, signData(signingKey, update.dataToSign));
  const intent = Intent.new(new Date(Date.now() + 30 * 60_000)).addMaintenanceUpdate(signed);
  const unprovenTx = Transaction.fromParts(network.networkId, undefined, undefined, intent);
  return submitTx(providers as never, { unprovenTx } as never);
};
