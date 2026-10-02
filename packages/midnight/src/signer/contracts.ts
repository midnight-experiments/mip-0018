// SPDX-License-Identifier: Apache-2.0
//
// Deploy, call and maintenance steps with before/after chain checks and a write-ahead submission journal
// (question Q13 (b); spec FR-040).
//
// The transaction path is midnight-js's own: `deployContract`, `findDeployedContract(...).callTx.<circuit>()` and,
// for ZKIR-v3 maintenance (Q23), a ledger-level MaintenanceUpdate submitted with midnight-js `submitTx`. Around it:
//
//   before   the step is skipped when the chain already shows it done (contract at the recorded address; the
//            circuit's key already removed; the contract's metadata already holding exactly what this publish
//            would set — checked on the finalized transaction just before submission, so nothing is spent);
//            a step with a recorded transaction is RECONCILED first (looked up; if invisible, waited for until its
//            TTL has passed — only then may it be submitted again)
//   journal  the midnight provider's submit is wrapped: the run record stores the transaction hash, identifiers,
//            TTL, the deploy's contract address (and the maintenance key + private state go to the 0600 file)
//            BEFORE the node sees the transaction
//   after    the step is `completed` only when the expected change is observed through the indexer (contract with
//            every compiled operation; exactly the expected Misc events in that transaction; key gone)

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { sampleSigningKey, type FinalizedTransaction, type SigningKey } from '@midnightntwrk/ledger-v9';
import { normHex } from '../hex.ts';
import { Indexer } from '../indexer.ts';
import { checkIdentity, IdentityError, normGenesis } from '../network.ts';
import { decodeTransaction, miscLogsOf } from '../raw.ts';
import { circuitArgs, fromJsonLoose } from './args.ts';
import type { AdapterContext, ContractAdapter } from './adapter.ts';
import { contractView, eventsInTx, pollFor, transactionState, wouldChange } from './check.ts';
import { checkAuthority, currentContractState, insertVerifierKey, onChainVerifierKey, removeVerifierKey } from './maintenance.ts';
import { filePrivateStateProvider, type FilePrivateStateProvider } from './private-state.ts';
import { buildProviders, loadCompiledContract, type CompiledArtifacts } from './providers.ts';
import { findStep, loadRecord, note, saveRecord, upsertStep, RecordError, type RunRecord, type StepRecord } from './records.ts';
import { describeWallet, waitForSync, type SignerEndpoints, type WalletSession } from './wallet.ts';

export class StepError extends Error {
  override name = 'StepError';
  readonly outcome: 'failed' | 'unknown' | 'refused';
  constructor(message: string, outcome: 'failed' | 'unknown' | 'refused') {
    super(message);
    this.outcome = outcome;
  }
}

/** Thrown from the journal when the before-check finds the publish already reflected on chain. */
class AlreadyPresent extends Error {
  override name = 'AlreadyPresent';
}

export interface RunOptions {
  ep: SignerEndpoints;
  session: WalletSession;
  recordPath: string;
  artifacts: CompiledArtifacts;
  /** The signer's private state file (0600, outside the repository). */
  privateStatePath: string;
  adapter?: ContractAdapter;
  adapterPath?: string;
  log?: (msg: string, extra?: unknown) => void;
  /** Disable the "metadata already present" before-check of publish (re-emit identical values on purpose). */
  force?: boolean;
  /** How long a re-run waits for an invisible recorded transaction (default: until its TTL + 60 s). */
  reconcileWaitMs?: number;
  /** How long the after-check polls the indexer for the expected change. */
  observeTimeoutMs?: number;
  /** TEST HOOK: SIGKILL this process right after the node accepted the step with this id or kind. */
  crashAfterSubmit?: string;
}

export interface Run {
  o: RunOptions;
  record: RunRecord;
  psp: FilePrivateStateProvider;
  save(): void;
  log(msg: string, extra?: unknown): void;
}

const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

export function verifierKeyHashes(managedDir: string): Record<string, string> {
  const dir = join(managedDir, 'keys');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.verifier'))
      .sort()
      .map((f) => [basename(f, '.verifier'), sha256File(join(dir, f))]),
  );
}

/** Opens (or creates) the run record and checks the chain identity before anything else. */
export async function openRun(o: RunOptions): Promise<Run> {
  const log = o.log ?? (() => {});
  const genesis = await checkIdentity(o.ep.profile);
  let record = loadRecord(o.recordPath);
  const keys = verifierKeyHashes(o.artifacts.managedDir);
  if (record) {
    if (normGenesis(record.network.genesisHash) !== genesis || record.network.id !== o.ep.profile.id) {
      throw new IdentityError(
        `${o.recordPath} was made on ${record.network.id} ${record.network.genesisHash}; this node is ${o.ep.profile.id} ${genesis}`,
      );
    }
    if (record.contract.name !== o.artifacts.name)
      throw new RecordError(`${o.recordPath} is for contract ${record.contract.name}, not ${o.artifacts.name}`);
    const changed = Object.keys(record.contract.verifierKeySha256).filter((c) => keys[c] !== record!.contract.verifierKeySha256[c]);
    if (changed.length > 0) throw new RecordError(`compiled verifier keys differ from the record for: ${changed.join(', ')} (recompiled?)`);
    log(`resuming ${o.recordPath}`);
  } else {
    record = {
      kind: 'mip0018-run-record',
      schema: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      network: {
        id: o.ep.profile.id,
        networkId: o.ep.profile.networkId,
        genesisHash: genesis,
        indexer: o.ep.profile.indexer,
        rpc: o.ep.profile.rpc,
      },
      contract: { name: o.artifacts.name, managedDir: o.artifacts.managedDir, verifierKeySha256: keys },
      steps: [],
    };
    if (o.adapterPath) record.contract.adapter = o.adapterPath;
  }
  const r = record;
  const psp = filePrivateStateProvider(o.privateStatePath);
  const run: Run = {
    o,
    record: r,
    psp,
    save: () => saveRecord(o.recordPath, r),
    log,
  };
  run.save();
  const synced = await waitForSync(o.session);
  const me = describeWallet(o.session, synced);
  if (r.signer && r.signer.unshieldedAddress !== me.unshieldedAddress)
    log(`note: this record was started by ${r.signer.unshieldedAddress}; signing now as ${me.unshieldedAddress}`);
  r.signer ??= { unshieldedAddress: me.unshieldedAddress };
  run.save();
  return run;
}

function ttlOf(tx: FinalizedTransaction): string | undefined {
  const intents = (tx as unknown as { intents?: Map<number, { ttl: Date }> }).intents;
  if (!intents || intents.size === 0) return undefined;
  return new Date(Math.max(...[...intents.values()].map((i) => i.ttl.getTime()))).toISOString();
}

function crashHook(run: Run, step: StepRecord): void {
  const want = run.o.crashAfterSubmit;
  if (want && (want === step.id || want === step.kind)) {
    run.log(`TEST HOOK: killing the signer right after submitting ${step.id}`);
    process.kill(process.pid, 'SIGKILL');
  }
}

/** Journal hooks for one step: write-ahead before the node sees the transaction. */
function journal(
  run: Run,
  step: StepRecord,
  extra: (tx: FinalizedTransaction, decoded: ReturnType<typeof decodeTransaction>) => Promise<void>,
) {
  return {
    onBeforeSubmit: async (tx: FinalizedTransaction) => {
      const d = decodeTransaction(tx as never);
      await extra(tx, d);
      const ttl = ttlOf(tx);
      step.tx = { hash: d.hash, identifiers: d.identifiers, ...(ttl ? { ttl } : {}) };
      step.state = 'submitting';
      note(step, `submitting ${d.hash}`);
      run.save();
    },
    onSubmitted: async (_tx: FinalizedTransaction, txId: string) => {
      if (step.tx) step.tx.txId = txId;
      step.state = 'submitted';
      note(step, `node accepted ${txId}`);
      run.save();
      crashHook(run, step);
    },
  };
}

function providersFor(
  run: Run,
  hooks: ReturnType<typeof journal> | Record<string, never>,
  artifacts: CompiledArtifacts = run.o.artifacts,
): MidnightProviders {
  return buildProviders(run.o.ep, run.o.session, artifacts, run.psp, hooks);
}

/**
 * Reconciles a step that has a recorded transaction: returns 'included' (inclusion filled in), 'expired' (it can no
 * longer be included: safe to submit again) or throws StepError('unknown') when the wait budget ran out first.
 */
async function reconcile(run: Run, step: StepRecord): Promise<'included' | 'expired'> {
  const tx = step.tx!;
  run.log(`reconciling ${step.id}: looking up ${tx.hash}`);
  const ttlMs = tx.ttl ? Date.parse(tx.ttl) : Date.parse(step.startedAt) + 30 * 60_000;
  const deadline = Math.min(ttlMs + 60_000, Date.now() + (run.o.reconcileWaitMs ?? Number.POSITIVE_INFINITY));
  const t = await pollFor(
    async () => (await transactionState(run.o.ep.profile, tx.hash)) ?? undefined,
    Math.max(0, deadline - Date.now()),
    5_000,
  );
  if (t) {
    step.inclusion = {
      height: t.block.height,
      hash: t.block.hash,
      status: t.transactionResult?.status ?? t.__typename,
      ...(t.fee ? { fee: t.fee } : {}),
    };
    note(step, `found ${tx.hash} in block ${t.block.height} (${step.inclusion.status})`);
    run.save();
    return 'included';
  }
  if (Date.now() >= ttlMs + 60_000) {
    note(step, `${tx.hash} was not included before its TTL ${tx.ttl ?? '(assumed 30 min)'}: it can no longer be; submitting again is safe`);
    delete step.tx;
    step.state = 'pending';
    run.save();
    return 'expired';
  }
  step.state = 'unknown';
  note(step, `${tx.hash} not visible yet; TTL ${tx.ttl} not reached — re-run later (never resubmitted blindly)`);
  run.save();
  throw new StepError(`${step.id}: transaction ${tx.hash} is not visible yet and its TTL has not passed; re-run to reconcile`, 'unknown');
}

async function inclusionOf(run: Run, step: StepRecord): Promise<void> {
  if (!step.tx || step.inclusion) return;
  const t = await new Indexer(run.o.ep.profile.indexer, run.o.ep.profile.indexerWs).waitForTransaction(step.tx.hash, {
    timeoutMs: run.o.observeTimeoutMs ?? 120_000,
  });
  if (t)
    step.inclusion = {
      height: t.block.height,
      hash: t.block.hash,
      status: t.transactionResult?.status ?? t.__typename,
      ...(t.fee ? { fee: t.fee } : {}),
    };
}

function finish(run: Run, step: StepRecord, observed: unknown, ok: boolean, why: string): StepRecord {
  step.observed = observed;
  step.state = ok ? 'completed' : 'failed';
  if (ok) step.completedAt = new Date().toISOString();
  else step.error = why;
  note(step, ok ? `completed: ${why}` : `FAILED: ${why}`);
  run.save();
  if (!ok) throw new StepError(`${step.id}: ${why}`, 'failed');
  return step;
}

function onPerformError(run: Run, step: StepRecord, e: unknown): never {
  if (e instanceof StepError) throw e;
  const msg = `${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e)}`.slice(0, 1500);
  step.error = msg;
  if (step.tx) {
    step.state = 'unknown';
    note(step, `error after submission (${msg.slice(0, 200)}); the outcome is reconciled from the chain on the next run`);
    run.save();
    throw new StepError(`${step.id}: ${msg}`, 'unknown');
  }
  step.state = 'pending';
  note(step, `refused before submission: ${msg.slice(0, 300)}`);
  run.save();
  throw new StepError(`${step.id}: ${msg} (nothing was submitted)`, 'refused');
}

// ---------------------------------------------------------------------------------------------------------- deploy

/** Every compiled circuit with a verifier key file. */
const compiledOperations = (managedDir: string) => Object.keys(verifierKeyHashes(managedDir)).sort();

async function afterDeploy(run: Run, step: StepRecord): Promise<StepRecord> {
  const address = run.record.contract.address!;
  const want = compiledOperations(run.o.artifacts.managedDir);
  await inclusionOf(run, step);
  const seen = await pollFor(async () => {
    const v = await contractView(run.o.ep.profile, address);
    return v.exists && want.every((op) => v.operations.includes(op)) ? v : undefined;
  }, run.o.observeTimeoutMs ?? 120_000);
  if (!seen) {
    step.state = 'unknown';
    note(step, 'contract not observed with every compiled operation yet');
    run.save();
    throw new StepError(`deploy: contract ${address} not observed yet; re-run to reconcile`, 'unknown');
  }
  return finish(run, step, seen, true, `contract ${address} on chain with ${seen.operations.join(', ')}`);
}

export async function deployStep(
  run: Run,
  constructorJson: unknown[] = [],
  metadata?: AdapterContext<unknown>['metadata'],
): Promise<StepRecord> {
  const step = upsertStep(run.record, { id: 'deploy', kind: 'deploy', args: constructorJson });
  if (step.state === 'completed') return step;
  // before: reconcile a recorded submission, or find the contract already there
  if (step.tx && (await reconcile(run, step)) === 'included') return afterDeploy(run, step);
  if (run.record.contract.address) {
    const v = await contractView(run.o.ep.profile, run.record.contract.address);
    if (v.exists) {
      step.skipped = `contract ${run.record.contract.address} already on chain (before-check)`;
      note(step, step.skipped);
      return afterDeploy(run, step);
    }
  }
  const a = run.o.adapter;
  const compiled = await loadCompiledContract(run.o.artifacts, a?.witnesses);
  const signingKey: SigningKey = sampleSigningKey();
  const privateState = a?.initialPrivateState?.();
  const privateStateId = a?.privateStateId ?? (privateState !== undefined ? run.o.artifacts.name : undefined);
  const ctx: AdapterContext<unknown> = { privateState, coinPublicKey: String(run.o.session.shieldedSecretKeys.coinPublicKey), metadata };
  const args = a?.constructorArgs ? a.constructorArgs(constructorJson, ctx) : (fromJsonLoose(constructorJson) as unknown[]);
  const hooks = journal(run, step, async (_tx, d) => {
    if (d.deploys.length !== 1) throw new StepError(`deploy transaction holds ${d.deploys.length} deploys`, 'refused');
    const address = d.deploys[0]!.address;
    // Secrets first (0600 file), then the public record: a crash after submission cannot lose the only
    // maintenance key or the owner secret of the new contract.
    await run.psp.setSigningKey(address, signingKey);
    if (privateStateId !== undefined) {
      await run.psp.setFor(address, privateStateId, privateState);
      run.record.contract.privateStateId = privateStateId;
    }
    run.record.contract.address = address;
    run.record.contract.constructorArgs = constructorJson;
  });
  try {
    run.log('deploying', { contract: run.o.artifacts.name });
    const options: Record<string, unknown> = { compiledContract: compiled, signingKey };
    if (args.length > 0) options.args = args;
    if (privateStateId !== undefined) Object.assign(options, { privateStateId, initialPrivateState: privateState });
    const deployed = (await deployContract(providersFor(run, hooks) as never, options as never)) as unknown as {
      deployTxData: { public: { txHash: string; blockHeight: number; status: string; contractAddress: string } };
    };
    const p = deployed.deployTxData.public;
    if (normHex(String(p.contractAddress)) !== run.record.contract.address)
      throw new StepError('midnight-js reports another contract address than the journal', 'failed');
    note(step, `midnight-js: ${p.status} at block ${p.blockHeight}`);
  } catch (e) {
    onPerformError(run, step, e);
  }
  return afterDeploy(run, step);
}

// ------------------------------------------------------------------------------------------------------------ call

export const callStepId = (circuit: string, json: unknown[]) =>
  `call:${circuit}:${createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 12)}`;

async function afterCall(run: Run, step: StepRecord): Promise<StepRecord> {
  const address = run.record.contract.address!;
  await inclusionOf(run, step);
  if (step.inclusion?.status === 'FAILURE') return finish(run, step, { inclusion: step.inclusion }, false, 'the transaction FAILED');
  const expected = step.expectedEvents ?? [];
  const seen = await pollFor(async () => {
    const evs = await eventsInTx(run.o.ep.profile, address, step.tx!.hash);
    return evs.length >= expected.length ? evs : undefined;
  }, run.o.observeTimeoutMs ?? 120_000);
  if (!seen) {
    step.state = 'unknown';
    note(step, 'expected events not observed yet');
    run.save();
    throw new StepError(`${step.id}: events not observed yet; re-run to reconcile`, 'unknown');
  }
  const got = seen.map((e) => ({ name: normHex(e.name), payload: normHex(e.payload) }));
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  return finish(
    run,
    step,
    { inclusion: step.inclusion, events: seen.map((e) => ({ id: e.id, name: e.name, payload: e.payload })) },
    ok,
    ok
      ? `${got.length} expected Misc event(s) observed in ${step.tx!.hash}`
      : `observed events differ from the transaction's logs (${got.length} vs ${expected.length})`,
  );
}

export interface CallInput {
  circuit: string;
  /** JSON arguments (converted with contract-info types, or by the adapter). */
  args: unknown[];
  stepId?: string;
  /**
   * Call through another compiled contract than the record's (S6 upgrade: the upgrade-only source whose circuit was
   * added with a VerifierKeyInsert); `adapter` gives its witnesses (none when omitted).
   */
  artifacts?: CompiledArtifacts;
  adapter?: ContractAdapter;
}

export async function callStep(run: Run, input: CallInput): Promise<StepRecord> {
  const address = run.record.contract.address;
  if (!address) throw new StepError('the record has no contract address: deploy first', 'refused');
  const step = upsertStep(run.record, {
    id: input.stepId ?? callStepId(input.circuit, input.args),
    kind: 'call',
    circuit: input.circuit,
    args: input.args,
  });
  if (step.state === 'completed') return step;
  if (step.tx && (await reconcile(run, step)) === 'included') return afterCall(run, step);
  // before: the contract exists and the circuit can still be called
  const v = await contractView(run.o.ep.profile, address);
  if (!v.exists) throw new StepError(`contract ${address} is not on chain`, 'refused');
  if (!v.operations.includes(input.circuit))
    throw new StepError(`${input.circuit} has no verifier key on ${address} (removed?); nothing submitted`, 'refused');
  const arts = input.artifacts ?? run.o.artifacts;
  const a = input.artifacts ? input.adapter : run.o.adapter;
  const privateStateId = run.record.contract.privateStateId;
  if (privateStateId !== undefined) run.psp.setContractAddress(address);
  let privateState = privateStateId !== undefined ? await run.psp.get(privateStateId) : undefined;
  if (privateStateId !== undefined && (privateState === null || privateState === undefined) && a?.initialPrivateState) {
    // This signer has no private state for the contract (it did not deploy it): give it its own, as midnight-js
    // `findDeployedContract({ initialPrivateState })` would. For an Ownable contract that is a different secret,
    // so the circuit's owner check fails locally and nothing is submitted.
    privateState = a.initialPrivateState();
    await run.psp.setFor(address, privateStateId, privateState);
    run.log("no private state for this contract in this signer's file: created a fresh one");
  }
  const ctx: AdapterContext<unknown> = {
    privateState: privateState ?? undefined,
    coinPublicKey: String(run.o.session.shieldedSecretKeys.coinPublicKey),
    contractAddress: address,
  };
  const args = a?.circuitArgs?.(input.circuit, input.args, ctx) ?? circuitArgs(arts.managedDir, input.circuit, input.args);
  const current = await new Indexer(run.o.ep.profile.indexer, run.o.ep.profile.indexerWs).allContractEvents(address, {});
  const hooks = journal(run, step, async (_tx, d) => {
    const logs = miscLogsOf(d, address).filter((l) => l.name !== undefined && l.payload !== undefined);
    step.expectedEvents = logs.map((l) => ({ name: l.name!, payload: l.payload! }));
    if (!run.o.force && wouldChange(run.o.ep.profile.id, address, current.events, step.expectedEvents) === false) {
      throw new AlreadyPresent('the contract metadata already holds exactly what this call would set');
    }
  });
  try {
    run.log(`calling ${input.circuit}`, { contract: address });
    const compiled = await loadCompiledContract(arts, a?.witnesses);
    const options: Record<string, unknown> = { compiledContract: compiled, contractAddress: address };
    if (privateStateId !== undefined) options.privateStateId = privateStateId;
    const found = (await findDeployedContract(providersFor(run, hooks, arts) as never, options as never)) as unknown as {
      callTx: Record<string, (...x: unknown[]) => Promise<{ public: { txHash: string; blockHeight: number; status: string } }>>;
    };
    const fn = found.callTx[input.circuit];
    if (!fn) throw new StepError(`the compiled contract has no circuit ${input.circuit}`, 'refused');
    const r = await fn(...args);
    note(step, `midnight-js: ${r.public.status} at block ${r.public.blockHeight}`);
  } catch (e) {
    const already =
      e instanceof AlreadyPresent || String((e as Error)?.message ?? '').includes('already holds exactly what this call would set');
    if (already && !step.tx) {
      step.state = 'completed';
      step.skipped =
        'the contract metadata already holds exactly these values (before-check on the finalized transaction; nothing submitted)';
      step.completedAt = new Date().toISOString();
      note(step, step.skipped);
      run.save();
      return step;
    }
    onPerformError(run, step, e);
  }
  return afterCall(run, step);
}

// ------------------------------------------------------------------------------------------ verifier key removal

export async function removeVerifierKeyStep(run: Run, circuit: string, slot: 'v3' | 'v4' = 'v4'): Promise<StepRecord> {
  const address = run.record.contract.address;
  if (!address) throw new StepError('the record has no contract address', 'refused');
  const step = upsertStep(run.record, { id: `verifier-key-remove:${circuit}`, kind: 'verifier-key-remove', circuit });
  if (step.state === 'completed') return step;
  const after = async (): Promise<StepRecord> => {
    await inclusionOf(run, step);
    const gone = await pollFor(async () => {
      const v = await contractView(run.o.ep.profile, address);
      return v.exists && !v.operations.includes(circuit) ? v : undefined;
    }, run.o.observeTimeoutMs ?? 120_000);
    if (!gone) {
      if (step.inclusion && step.inclusion.status !== 'SUCCESS')
        return finish(
          run,
          step,
          { inclusion: step.inclusion },
          false,
          `the update was included as ${step.inclusion.status} and the key is still present`,
        );
      step.state = 'unknown';
      run.save();
      throw new StepError(`${step.id}: key still present; re-run to reconcile`, 'unknown');
    }
    return finish(run, step, gone, true, `${circuit} has no verifier key any more`);
  };
  if (step.tx && (await reconcile(run, step)) === 'included') return after();
  const v = await contractView(run.o.ep.profile, address);
  if (!v.exists) throw new StepError(`contract ${address} is not on chain`, 'refused');
  if (!v.operations.includes(circuit)) {
    step.skipped = `${circuit} already has no verifier key (before-check)`;
    note(step, step.skipped);
    return after();
  }
  const key = await run.psp.getSigningKey(address);
  if (!key) throw new StepError(`no maintenance signing key for ${address} in ${run.o.privateStatePath}`, 'refused');
  const hooks = journal(run, step, async () => {});
  try {
    run.log(`removing the ${circuit} verifier key (${slot})`, { contract: address });
    const r = (await removeVerifierKey(
      providersFor(run, hooks),
      run.o.ep.profile,
      address,
      circuit,
      key as SigningKey,
      slot,
    )) as unknown as { status: string; blockHeight: number };
    note(step, `midnight-js submitTx: ${r.status} at block ${r.blockHeight}`);
  } catch (e) {
    onPerformError(run, step, e);
  }
  return after();
}

// ----------------------------------------------------------------------------------------- verifier key insertion

export interface InsertInput {
  circuit: string;
  /** The new circuit's verifier key (keys/<circuit>.verifier of the upgrade-only build). */
  verifierKey: Uint8Array;
  slot?: 'v3' | 'v4';
  /** The maintenance key; default: the one stored for the contract in the private-state file at deploy. */
  signingKey?: SigningKey;
  /** Submit even when the before-check refuses (key already present, key not in the committee): the chain decides. */
  force?: boolean;
  stepId?: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The node refused the transaction outright (never included). */
const NODE_REJECTION = /Invalid Transaction|InvalidTransaction|\b1010\b|Custom error/u;

/**
 * An error's message with its causes: the wallet SDK reports a node rejection as an Effect `FiberFailure` wrapping
 * `SubmissionError("Transaction submission error")`, whose `cause` (the node client's error) holds the node's reason.
 */
export function describeError(e: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (e === null || e === undefined || depth > 8 || seen.has(e)) return '';
  if (typeof e !== 'object') return String(e);
  seen.add(e);
  const o = e as Record<string | symbol, unknown>;
  const parts: string[] = [];
  const head = [o._tag, o.name, o.message].filter((x) => typeof x === 'string' && x !== '').join(': ');
  if (head) parts.push(head);
  for (const k of ['cause', 'error', 'defect', 'left', 'right', 'failure', 'data', 'details', 'reason']) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    parts.push(typeof v === 'object' ? describeError(v, depth + 1, seen) : String(v));
  }
  for (const sym of Object.getOwnPropertySymbols(o)) {
    const v = o[sym];
    if (v && typeof v === 'object') parts.push(describeError(v, depth + 1, seen));
  }
  return [...new Set(parts.filter((x) => x !== ''))].join(' <- ');
}

/**
 * VerifierKeyInsert (MIP-0018 "Existing contracts", step 2): adds a circuit's verifier key to the deployed contract,
 * signed by its maintenance authority. ZKIR-v3 keys go in the v4 slot (Q23).
 *
 * before  skipped when the circuit already has exactly this key (a re-run); REFUSED when it has another key (the
 *         ledger never overwrites: VerifierKeyAlreadyPresent) or when the key cannot sign for the authority (frozen
 *         or other committee, threshold > 1) — unless `force`, which submits anyway so the chain's answer is recorded
 * after   completed only when the indexer shows the circuit with this key; included-but-failed and node rejections are
 *         `failed` with the reason (key unchanged)
 */
export async function insertVerifierKeyStep(run: Run, input: InsertInput): Promise<StepRecord> {
  const address = run.record.contract.address;
  if (!address) throw new StepError('the record has no contract address', 'refused');
  const { circuit } = input;
  const slot = input.slot ?? 'v4';
  const want = sha256(input.verifierKey);
  const step = upsertStep(run.record, {
    id: input.stepId ?? `verifier-key-insert:${circuit}`,
    kind: 'verifier-key-insert',
    circuit,
    args: { slot, verifierKeySha256: want, key: input.signingKey ? 'from --maintenance-key-file' : 'deploy-time key (private-state file)' },
  });
  if (step.state === 'completed') return step;
  // Refusals are recorded (state stays `pending`, nothing was submitted) before the error is raised.
  const refuse = (msg: string): never => {
    step.error = msg;
    note(step, `refused before submission: ${msg.slice(0, 300)}`);
    run.save();
    throw new StepError(msg, 'refused');
  };
  const keyView = async () => {
    const st = await currentContractState(run.o.ep.profile, address);
    const k = onChainVerifierKey(st, circuit);
    return { state: st, keySha256: k ? sha256(k) : undefined, counter: st.maintenanceAuthority.counter.toString() };
  };
  const after = async (): Promise<StepRecord> => {
    await inclusionOf(run, step);
    if (step.inclusion && step.inclusion.status !== 'SUCCESS') {
      const v = await keyView();
      return finish(
        run,
        step,
        { inclusion: step.inclusion, keySha256: v.keySha256 ?? null, authorityCounter: v.counter },
        false,
        `included as ${step.inclusion.status}: the ledger refused the update (${circuit} key ${v.keySha256 === want ? 'equals ours' : v.keySha256 ? 'unchanged, another key' : 'absent'}; counter ${v.counter})`,
      );
    }
    const seen = await pollFor(async () => {
      const v = await keyView();
      return v.keySha256 === want ? v : undefined;
    }, run.o.observeTimeoutMs ?? 120_000);
    if (!seen) {
      step.state = 'unknown';
      note(step, `${circuit} not observed with the inserted key yet`);
      run.save();
      throw new StepError(`${step.id}: key not observed yet; re-run to reconcile`, 'unknown');
    }
    return finish(
      run,
      step,
      {
        inclusion: step.inclusion,
        operations: (await contractView(run.o.ep.profile, address)).operations,
        keySha256: want,
        authorityCounter: seen.counter,
      },
      true,
      `${circuit} now has the inserted ${slot} verifier key (sha256 ${want.slice(0, 16)}…)`,
    );
  };
  if (step.tx && (await reconcile(run, step)) === 'included') return after();
  // before
  const v = await keyView().catch(() => undefined);
  if (!v) return refuse(`contract ${address} is not on chain`);
  if (v.keySha256 === want && !input.force) {
    step.skipped = `${circuit} already has exactly this verifier key (before-check)`;
    note(step, step.skipped);
    return after();
  }
  if (v.keySha256 !== undefined && !input.force)
    return refuse(
      `${circuit} already has another verifier key on ${address}; VerifierKeyInsert never overwrites (the ledger refuses with VerifierKeyAlreadyPresent) — nothing submitted`,
    );
  const key = input.signingKey ?? ((await run.psp.getSigningKey(address)) as SigningKey | null) ?? undefined;
  if (!key) return refuse(`no maintenance signing key for ${address} in ${run.o.privateStatePath} (give --maintenance-key-file)`);
  const auth = checkAuthority(v.state.maintenanceAuthority, key);
  step.observed = { before: { keySha256: v.keySha256 ?? null, authority: { ...auth, reason: undefined } } };
  if (!auth.ok) {
    if (!input.force) return refuse(`${auth.reason} — nothing submitted`);
    note(step, `--force: submitting although ${auth.reason}`);
  }
  if (v.keySha256 !== undefined) note(step, `--force: submitting although ${circuit} already has a verifier key`);
  const hooks = journal(run, step, async () => {});
  try {
    run.log(`inserting the ${circuit} verifier key (${slot})`, { contract: address });
    const r = (await insertVerifierKey(
      providersFor(run, hooks),
      run.o.ep.profile,
      address,
      circuit,
      input.verifierKey,
      key,
      slot,
      BigInt(Math.max(0, auth.index)),
    )) as unknown as { status: string; blockHeight: number };
    note(step, `midnight-js submitTx: ${r.status} at block ${r.blockHeight}`);
  } catch (e) {
    const msg = describeError(e).slice(0, 1500);
    if (step.tx && step.state === 'submitting' && NODE_REJECTION.test(msg)) {
      // The node refused the transaction at submission: it was never accepted into the pool, so it cannot be
      // included later (only this signer ever held it).
      step.error = msg;
      step.state = 'failed';
      step.observed = {
        ...(step.observed as object),
        rejectedByNode: msg,
        after: await keyView().then((x) => ({ keySha256: x.keySha256 ?? null, authorityCounter: x.counter })),
      };
      note(step, `REJECTED by the node at submission: ${msg.slice(0, 300)}`);
      run.save();
      throw new StepError(`${step.id}: rejected by the node: ${msg.slice(0, 300)}`, 'failed');
    }
    onPerformError(run, step, e);
  }
  return after();
}

export { findStep };
