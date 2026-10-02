// SPDX-License-Identifier: Apache-2.0
//
// Create-and-destroy on the local undeployed chain (docker/local-stack), end to end:
//
//   deploy CreateAndDestroy -> publishMetadata() (unguarded) -> the indexer has ONE Misc event equal
//   to MIP test A1 -> a holder transfer emits no Misc event -> VerifierKeyRemove(publishMetadata, v4)
//   signed by the maintenance authority (the deployer) -> a second publishMetadata() is refused
//   (no verifier key) -> still exactly one Misc event; `transfer` keeps its key.
//
// Signs with the local dev chain's genesis wallet, whose seed is public (0x00..01): no secret.
// The maintenance update uses the `v4` key slot (ZKIR v3), questions Q23: midnight-js 5.0.0-rc.2
// `removeVerifierKey()` only removes the `v3` slot.
//
// Chain helpers come from the S0 toolchain spike (test-contracts/toolchain-spike/src/lib, as of
// b1482e8). Run on the stack network, after a full-key compile:
//
//   docker/local-stack/up.sh && . docker/local-stack/ports.env
//   docker/run.sh exec 'npm run -w examples/minimal compile -- --keys CreateAndDestroy'
//   MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK docker/run.sh exec 'npm run -w examples/minimal create-and-destroy'
//   docker/local-stack/down.sh

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { ContractState, sampleSigningKey } from '@midnightntwrk/ledger-v9';
import { classifyEvent, fromHex, toHex } from '@mip0018/codec';
import { WebSocket } from 'ws';
import {
  contractView,
  graphql,
  miscEvents,
  preflight,
  transactionByHash,
  waitFor,
} from '../../../test-contracts/toolchain-spike/src/lib/chain.js';
import { removeVerifierKey } from '../../../test-contracts/toolchain-spike/src/lib/maintenance.js';
import { local, type NetworkConfig } from '../../../test-contracts/toolchain-spike/src/lib/network.js';
import { filePrivateStateProvider } from '../../../test-contracts/toolchain-spike/src/lib/private-state.js';
import {
  closeWallet,
  describe,
  midnightJsProviders,
  openWallet,
  waitForDust,
  waitForSync,
} from '../../../test-contracts/toolchain-spike/src/lib/wallet.js';
import { MANAGED_DIR, witnesses, type MinimalPrivateState } from '../src/contracts.ts';

const CONTRACT = 'CreateAndDestroy';
const CIRCUIT = 'publishMetadata';
const GENESIS_DEV_SEED = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex');
const REPO = join(import.meta.dirname, '..', '..', '..');
const A1 = JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', 'A1.json'), 'utf8')) as {
  event: { name_hex: string; payload_hex: string };
};
const DOMAIN = new Uint8Array(32).fill(0x11);

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const recordPath = process.env.MINIMAL_RECORD ?? join(REPO, 'docker', 'local-stack', '.state', `minimal-create-and-destroy-${stamp}.json`);
const record: Record<string, unknown> & { steps: Record<string, unknown> } = {
  kind: 'mip-0018-minimal-create-and-destroy',
  startedAt: new Date().toISOString(),
  steps: {},
};
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const save = () => {
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(`${recordPath}.tmp`, `${json(record)}\n`);
  renameSync(`${recordPath}.tmp`, recordPath);
};
const log = (msg: string, extra?: unknown) =>
  process.stderr.write(`${new Date().toISOString()} ${msg}${extra === undefined ? '' : ` ${json(extra)}`}\n`);

type TxData = { txId?: unknown; txHash?: unknown; blockHeight?: unknown; status?: unknown; contractAddress?: unknown };
type Handle = { deployTxData: { public: TxData }; callTx: Record<string, (...a: unknown[]) => Promise<{ public: TxData }>> };

const tx = async (network: NetworkConfig, data: TxData, seconds: number) => {
  const txHash = String(data.txHash);
  const seen = await waitFor(`transaction ${txHash}`, () => transactionByHash(network, txHash));
  return {
    txHash,
    blockHeight: Number(data.blockHeight),
    status: String(data.status),
    indexerStatus: seen?.status,
    feeSpecks: seen?.fee,
    seconds,
  };
};

const operationSizes = async (network: NetworkConfig, address: string) => {
  const { contractAction } = await graphql<{ contractAction: { state: string } }>(
    network,
    'query ($address: HexEncoded!) { contractAction(address: $address) { state } }',
    { address },
  );
  const state = ContractState.deserialize(Buffer.from(contractAction.state, 'hex'));
  const out: Record<string, { serialized: number; verifierKey: number }> = {};
  for (const op of state.operations()) {
    const name = typeof op === 'string' ? op : Buffer.from(op).toString('utf8');
    try {
      const o = state.operation(op);
      if (o) out[name] = { serialized: o.serialize().length, verifierKey: o.verifierKey.length };
    } catch {
      out[name] = { serialized: -1, verifierKey: 0 };
    }
  }
  return out;
};

const main = async () => {
  const network = local();
  setNetworkId(network.networkId);
  record.preflight = await preflight(network);
  save();

  const session = await openWallet(network, GENESIS_DEV_SEED);
  try {
    await waitForSync(session);
    record.wallet = describe(session, await waitForDust(session));
    save();

    const dir = join(MANAGED_DIR, CONTRACT);
    const info = JSON.parse(readFileSync(join(dir, 'compiler', 'contract-info.json'), 'utf8')) as Record<string, string>;
    record.toolchain = {
      compactCompiler: info['compiler-version'],
      compactLanguage: info['language-version'],
      zkir: 'v3 (--feature-zkir-v3)',
    };
    const mod = (await import(pathToFileURL(join(dir, 'contract', 'index.js')).href)) as {
      Contract: new (...a: never[]) => never;
      pureCircuits: { accountId(sk: Uint8Array): Uint8Array };
    };
    const compiledContract = CompiledContract.make(CONTRACT, mod.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses as never),
      CompiledContract.withCompiledFileAssets(dir as never),
    );
    const zkConfigProvider = new NodeZkConfigProvider<string>(dir);
    const providers: MidnightProviders = {
      privateStateProvider: filePrivateStateProvider(),
      publicDataProvider: indexerPublicDataProvider({
        queryURL: network.indexer,
        subscriptionURL: network.indexerWs,
        webSocket: WebSocket as never,
      }),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider, { timeout: 600_000 }),
      ...midnightJsProviders(session),
    } as MidnightProviders;

    // The token holder (its secret key lives only in this run's memory).
    const holderSk = crypto.getRandomValues(new Uint8Array(32));
    const holder = mod.pureCircuits.accountId(holderSk);
    const recipient = mod.pureCircuits.accountId(crypto.getRandomValues(new Uint8Array(32)));
    const signingKey = sampleSigningKey(); // maintenance authority = the deployer

    // --- deploy ---
    let t = Date.now();
    const deployed = (await deployContract(
      providers as never,
      {
        compiledContract: compiledContract as never,
        signingKey,
        args: [DOMAIN, 1000n, holder],
        privateStateId: 'holder',
        initialPrivateState: { secretKey: holderSk } satisfies MinimalPrivateState,
      } as never,
    )) as unknown as Handle;
    const address = String(deployed.deployTxData.public.contractAddress);
    record.contract = address;
    record.steps.deploy = await tx(network, deployed.deployTxData.public, Math.round((Date.now() - t) / 1000));
    const afterDeploy = await waitFor('contract with publishMetadata', async () => {
      const v = await contractView(network, address);
      return v.exists && v.operations.includes(CIRCUIT) ? v : undefined;
    });
    record.steps.deploy = {
      ...(record.steps.deploy as object),
      operations: afterDeploy.operations,
      operationSizes: await operationSizes(network, address),
    };
    save();
    log('deployed', record.steps.deploy);
    if ((await miscEvents(network, address)).length !== 0) throw new Error('a Misc event exists before publishMetadata');

    // --- publishMetadata (unguarded, constant payload) ---
    t = Date.now();
    const published = await deployed.callTx[CIRCUIT]!();
    const pubHash = String(published.public.txHash);
    const events = await waitFor('the Misc event', async () => {
      const e = await miscEvents(network, address, pubHash);
      return e.length > 0 ? e : undefined;
    });
    const ev = events[0]!;
    const c = classifyEvent({ type: 'Misc', name: fromHex(ev.name), payload: fromHex(ev.payload) });
    record.steps.publish = {
      ...(await tx(network, published.public, Math.round((Date.now() - t) / 1000))),
      eventsInTx: events.length,
      eventContract: ev.contractAddress,
      nameEqualsA1: ev.name === A1.event.name_hex,
      payloadEqualsA1: ev.payload === A1.event.payload_hex,
      codec: c.result,
      raw: ev.raw,
    };
    save();
    log('published', record.steps.publish);
    if (
      events.length !== 1 ||
      ev.contractAddress !== address ||
      ev.name !== A1.event.name_hex ||
      ev.payload !== A1.event.payload_hex ||
      c.result !== 'accept'
    )
      throw new Error('the indexed event is not the A1 event of this contract');

    // --- normal operation: a holder transfer emits no Misc event ---
    t = Date.now();
    const moved = await deployed.callTx.transfer!(recipient, 250n);
    const movedHash = String(moved.public.txHash);
    record.steps.transfer = {
      ...(await tx(network, moved.public, Math.round((Date.now() - t) / 1000))),
      miscEventsInTx: (await miscEvents(network, address, movedHash)).length,
    };
    save();
    log('transfer', record.steps.transfer);
    if ((record.steps.transfer as { miscEventsInTx: number }).miscEventsInTx !== 0) throw new Error('transfer emitted a Misc event');

    // --- destroy: VerifierKeyRemove(publishMetadata, v4) by the maintenance authority ---
    t = Date.now();
    const removed = await removeVerifierKey(providers, network, address, CIRCUIT, signingKey, 'v4');
    record.steps.removeVerifierKey = await tx(network, removed as unknown as TxData, Math.round((Date.now() - t) / 1000));
    const afterRemove = await waitFor('contract without publishMetadata', async () => {
      const v = await contractView(network, address);
      return v.exists && !v.operations.includes(CIRCUIT) ? v : undefined;
    });
    record.steps.removeVerifierKey = { ...(record.steps.removeVerifierKey as object), operations: afterRemove.operations };
    save();
    log('verifier key removed', record.steps.removeVerifierKey);
    if (!afterRemove.operations.includes('transfer')) throw new Error('transfer lost its verifier key');

    // --- a second publishMetadata() must be refused ---
    let failure: string | undefined;
    try {
      await deployed.callTx[CIRCUIT]!();
    } catch (e) {
      failure = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 600);
    }
    const all = await miscEvents(network, address);
    record.steps.secondCall = { refused: failure !== undefined, error: failure, miscEventsTotal: all.length };
    record.result = failure !== undefined && all.length === 1 ? 'passed' : 'failed';
    save();
    log('second call', record.steps.secondCall);
    if (record.result !== 'passed') throw new Error('the second call was not refused');
    process.stdout.write(
      `${json({ result: record.result, contract: address, record: recordPath, payload: toHex(fromHex(ev.payload)).slice(0, 16) + '…' })}\n`,
    );
  } finally {
    await closeWallet(session);
  }
};

main().catch((e: unknown) => {
  record.result = 'failed';
  record.error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 2000);
  save();
  process.stderr.write(`create-and-destroy failed: ${(e as Error).stack ?? String(e)}\nrecord: ${recordPath}\n`);
  process.exitCode = 1;
});
