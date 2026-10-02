// SPDX-License-Identifier: Apache-2.0
//
// The S0 toolchain gate, shared by the local stack and Stagenet:
//
//   preflight -> deploy SpikeEmitter (midnight-js deployContract) -> call
//   publishMetadata (callTx) -> the indexer returns the Misc event with the A1
//   bytes -> VerifierKeyRemove of publishMetadata (create and destroy) ->
//   [local only] a second call must fail.
//
// Chain state is read before and after every transaction (Q13 (b)); a step is
// marked done only when its effect is observed. The public record is written
// after every step and never contains a secret.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { sampleSigningKey } from '@midnightntwrk/ledger-v9';
import { contractView, miscEvents, preflight, transactionByHash, waitFor } from './chain.js';
import type { NetworkConfig } from './network.js';
import { A1_PAYLOAD_HEX, EVENT_NAME_HEX } from './expected.js';
import { describeOperation, removeVerifierKey } from './maintenance.js';
import { buildProviders, loadCompiledContract } from './providers.js';
import { describe, waitForDust, waitForSync, type WalletSession } from './wallet.js';

export const CONTRACT = 'SpikeEmitter';
export const CIRCUIT = 'publishMetadata';

type Step = Record<string, unknown> & { done?: boolean };

type TxData = { txId?: unknown; txHash?: unknown; blockHeight?: unknown; status?: unknown; contractAddress?: unknown };
type Handle = {
  deployTxData: { public: TxData };
  callTx: Record<string, () => Promise<{ public: TxData }>>;
  circuitMaintenanceTx: Record<string, { removeVerifierKey(): Promise<TxData> }>;
};

export type SpikeRecord = {
  kind: 'mip-0018-s0-toolchain-spike';
  network: string;
  startedAt: string;
  toolchain: Record<string, string>;
  preflight?: unknown;
  wallet?: unknown;
  contract?: string;
  steps: Record<string, Step>;
  result?: 'passed' | 'failed';
  error?: string;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

export const recorder = (path: string, record: SpikeRecord) => (patch?: (r: SpikeRecord) => void) => {
  patch?.(record);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${json(record)}\n`);
  renameSync(tmp, path);
};

const log = (msg: string, extra?: unknown) =>
  process.stderr.write(`${new Date().toISOString()} ${msg}${extra === undefined ? '' : ` ${json(extra)}`}\n`);

const txSummary = async (network: NetworkConfig, data: TxData) => {
  const txHash = String(data.txHash);
  const seen = await waitFor(`transaction ${txHash} in the indexer`, () => transactionByHash(network, txHash));
  return {
    txId: String(data.txId),
    txHash,
    blockHeight: Number(data.blockHeight),
    blockHash: seen?.block.hash,
    status: String(data.status),
    indexerStatus: seen?.status,
    feeSpecks: seen?.fee,
  };
};

export type SpikeOptions = {
  network: NetworkConfig;
  session: WalletSession;
  recordPath: string;
  privateStatePath?: string;
  /** Try a second call after the key removal and require it to fail (local only: it costs nothing there). */
  secondCall: boolean;
  /** First try midnight-js removeVerifierKey() and record its outcome (local only). */
  tryMidnightJsRemove: boolean;
  /** Abort unless the wallet's unshielded address equals this (Stagenet: wallet 1). */
  expectedUnshieldedAddress?: string;
  toolchain: Record<string, string>;
};

export const runSpike = async (o: SpikeOptions): Promise<SpikeRecord> => {
  const record: SpikeRecord = {
    kind: 'mip-0018-s0-toolchain-spike',
    network: o.network.name,
    startedAt: new Date().toISOString(),
    toolchain: o.toolchain,
    steps: {},
  };
  const save = recorder(o.recordPath, record);
  save();
  try {
    record.preflight = await preflight(o.network);
    save();
    log('preflight', record.preflight);

    log('syncing wallet (this can take minutes on a public network)');
    const t0 = Date.now();
    await waitForSync(o.session);
    const synced = await waitForDust(o.session);
    const identity = describe(o.session, synced);
    record.wallet = { ...identity, syncSeconds: Math.round((Date.now() - t0) / 1000) };
    save();
    log('wallet', record.wallet);
    if (o.expectedUnshieldedAddress && identity.unshieldedAddress !== o.expectedUnshieldedAddress) {
      throw new Error(`wallet mismatch: ${identity.unshieldedAddress} is not the expected signer`);
    }

    const compiledContract = await loadCompiledContract(CONTRACT);
    const providers = buildProviders(o.network, o.session, CONTRACT, o.privateStatePath);

    // The maintenance key is created and stored BEFORE the deploy is submitted, so a
    // crash after submission cannot lose the only key able to remove the circuit.
    const signingKey = sampleSigningKey();
    await providers.privateStateProvider.setSigningKey('pending-deploy', signingKey);

    // --- deploy ---
    const dustBefore = (await waitForSync(o.session)).dust.balance(new Date());
    log('deploying', { contract: CONTRACT });
    let t = Date.now();
    const deployed = (await deployContract(providers as never, { compiledContract: compiledContract as never, signingKey } as never)) as unknown as Handle;
    const deployPublic = deployed.deployTxData.public;
    const address = String(deployPublic.contractAddress);
    record.contract = address;
    record.steps.deploy = { ...(await txSummary(o.network, deployPublic)), seconds: Math.round((Date.now() - t) / 1000) };
    save();
    const afterDeploy = await waitFor('contract state with publishMetadata', async () => {
      const v = await contractView(o.network, address);
      return v.exists && v.operations.includes(CIRCUIT) ? v : undefined;
    });
    record.steps.deploy = { ...record.steps.deploy, observed: afterDeploy, done: true };
    save();
    log('deployed', record.steps.deploy);

    // --- call publishMetadata ---
    const eventsBefore = await miscEvents(o.network, address);
    if (eventsBefore.length !== 0) throw new Error(`expected no Misc event before the call, found ${eventsBefore.length}`);
    log('calling publishMetadata');
    t = Date.now();
    const callResult = await deployed.callTx[CIRCUIT]!();
    record.steps.call = { ...(await txSummary(o.network, callResult.public)), seconds: Math.round((Date.now() - t) / 1000) };
    save();
    const callHash = String(callResult.public.txHash);
    const events = await waitFor('the Misc event in the indexer', async () => {
      const e = await miscEvents(o.network, address, callHash);
      return e.length > 0 ? e : undefined;
    });
    const ev = events[0]!;
    const nameOk = ev.name === EVENT_NAME_HEX;
    const payloadOk = ev.payload === A1_PAYLOAD_HEX;
    record.steps.call = {
      ...record.steps.call,
      event: { id: ev.id, contractAddress: ev.contractAddress, name: ev.name, payload: ev.payload, raw: ev.raw, block: ev.transaction.block },
      eventsInTx: events.length,
      nameEqualsExpected: nameOk,
      payloadEqualsA1: payloadOk,
      done: nameOk && payloadOk && events.length === 1 && ev.contractAddress === address,
    };
    save();
    log('called', record.steps.call);
    if (!record.steps.call.done) throw new Error('the indexed event does not equal the expected A1 bytes');

    // --- VerifierKeyRemove (create and destroy) ---
    const opBefore = await describeOperation(o.network, address, CIRCUIT);
    const key = (await providers.privateStateProvider.getSigningKey(address)) ?? signingKey;
    const found = (await findDeployedContract(providers as never, { compiledContract: compiledContract as never, contractAddress: address } as never)) as unknown as Handle;
    if (o.tryMidnightJsRemove) {
      // Evidence for the SDK limitation: midnight-js removes the 'v3' slot only.
      log('removing the verifier key with midnight-js circuitMaintenanceTx (expected to fail for a ZKIR v3 key)');
      let sdkOutcome: Record<string, unknown>;
      try {
        const r = await found.circuitMaintenanceTx[CIRCUIT]!.removeVerifierKey();
        sdkOutcome = { ...(await txSummary(o.network, r)) };
      } catch (e) {
        const err = e as Error & { finalizedTxData?: TxData };
        const m = /"txHash":\s*"([0-9a-f]+)"/u.exec(err.message);
        const status = /"status":\s*"([A-Za-z]+)"/u.exec(err.message);
        sdkOutcome = { error: err.name, status: status?.[1], txHash: m?.[1] };
        if (m?.[1]) sdkOutcome = { ...sdkOutcome, ...(await txSummary(o.network, { txHash: m[1], status: status?.[1] })) };
      }
      const still = await contractView(o.network, address);
      record.steps.removeVerifierKeyMidnightJs = { ...sdkOutcome, keyStillPresent: still.operations.includes(CIRCUIT), operationBefore: opBefore };
      save();
      log('midnight-js removeVerifierKey', record.steps.removeVerifierKeyMidnightJs);
    }
    log('removing the publishMetadata verifier key (MaintenanceUpdate, VerifierKeyRemove v4)');
    t = Date.now();
    const removed = await removeVerifierKey(providers, o.network, address, CIRCUIT, key, 'v4');
    record.steps.removeVerifierKey = {
      ...(await txSummary(o.network, removed as unknown as TxData)),
      seconds: Math.round((Date.now() - t) / 1000),
      operationBefore: opBefore,
      version: 'v4',
    };
    save();
    const afterRemove = await waitFor('contract state without publishMetadata', async () => {
      const v = await contractView(o.network, address);
      return v.exists && !v.operations.includes(CIRCUIT) ? v : undefined;
    });
    record.steps.removeVerifierKey = { ...record.steps.removeVerifierKey, observed: afterRemove, done: true };
    save();
    log('verifier key removed', record.steps.removeVerifierKey);

    // --- second call must fail ---
    if (o.secondCall) {
      log('second call (must fail)');
      let failure: string | undefined;
      try {
        await deployed.callTx[CIRCUIT]!();
      } catch (e) {
        failure = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 600);
      }
      const eventsAfter = await miscEvents(o.network, address);
      record.steps.secondCall = { failed: failure !== undefined, error: failure, miscEventsAfter: eventsAfter.length, done: failure !== undefined && eventsAfter.length === 1 };
      save();
      log('second call', record.steps.secondCall);
      if (!record.steps.secondCall.done) throw new Error('the second call did not fail as required');
    }

    const dustAfter = (await waitForSync(o.session)).dust.balance(new Date());
    record.steps.dust = { before: dustBefore.toString(), after: dustAfter.toString(), note: 'wallet DUST balance (SPECK); generation continues meanwhile, so the indexer fee per step is the exact cost' };
    record.result = 'passed';
    save();
    return record;
  } catch (e) {
    record.result = 'failed';
    record.error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 2000);
    save();
    throw e;
  }
};
