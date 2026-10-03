// SPDX-License-Identifier: Apache-2.0
//
// Run records: one public JSON file per contract run, rewritten atomically after
// every state change, holding the contract address and, for every step (deploy, each call, each maintenance update):
//
//   pending      created, nothing submitted
//   submitting   WRITE-AHEAD: the finalized transaction's hash, identifiers and TTL (and for a deploy the contract
//                address, for a call the Misc events it logs) are recorded BEFORE the node sees it
//   submitted    the node accepted it (transaction id)
//   unknown      the outcome is not observed yet (crash, timeout): only the chain check resolves it — it is never
//                retried blindly; a re-run looks the recorded transaction up, waits until its TTL has passed if it is
//                not visible, and only then may submit again
//   completed    the after-check OBSERVED the expected change on chain (or the before-check found it already done)
//   failed       included but failed, or the after-check contradicts the expectation
//
// Records never contain a secret: no mnemonic, seed, signing key or private state (those stay in the signer's 0600
// private-state file).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { toJson } from '../hex.ts';

export type StepState = 'pending' | 'submitting' | 'submitted' | 'unknown' | 'completed' | 'failed';
export type StepKind = 'deploy' | 'call' | 'verifier-key-remove' | 'verifier-key-insert';

export interface TxRef {
  hash: string;
  identifiers: string[];
  /** Latest intent TTL (ISO); after it the transaction cannot be included. */
  ttl?: string;
  txId?: string;
}

export interface StepRecord {
  id: string;
  kind: StepKind;
  circuit?: string;
  /** Typed JSON of the arguments (public values only). */
  args?: unknown;
  state: StepState;
  /** Before-check result when the step was found already done. */
  skipped?: string;
  /** Contract Misc events (name ‖ payload hex) the submitted transaction logs, from the finalized transaction. */
  expectedEvents?: { name: string; payload: string }[];
  tx?: TxRef;
  inclusion?: { height: number; hash: string; status: string; fee?: string };
  observed?: unknown;
  error?: string;
  attempts: { at: string; event: string }[];
  startedAt: string;
  completedAt?: string;
}

export interface RunRecord {
  kind: 'mip0018-run-record';
  schema: 1;
  createdAt: string;
  updatedAt: string;
  network: { id: string; networkId: string; genesisHash: string; indexer: string; rpc: string };
  contract: {
    name: string;
    managedDir: string;
    adapter?: string;
    /** SHA-256 of each `keys/<circuit>.verifier` at deploy time. */
    verifierKeySha256: Record<string, string>;
    constructorArgs?: unknown;
    address?: string;
    privateStateId?: string;
    /** Set when this record was attached to a contract it did not deploy (`--attach`): where the address came from. */
    attached?: { from: string; at: string };
    /** Circuits added later with a VerifierKeyInsert (the upgrade template), and the source they were compiled from. */
    upgrades?: UpgradeEntry[];
  };
  signer?: { unshieldedAddress: string };
  steps: StepRecord[];
}

export interface UpgradeEntry {
  circuit: string;
  slot: 'v3' | 'v4';
  /** The upgrade-only compiled contract (name, managed dir, adapter) the circuit is called through. */
  contract: string;
  managedDir: string;
  adapter?: string;
  verifierKeySha256: string;
  /** Pre-checks run before the insert (layout, on-chain decode, authority) — public values only. */
  checks?: unknown;
}

export class RecordError extends Error {
  override name = 'RecordError';
}

export function loadRecord(path: string): RunRecord | undefined {
  if (!existsSync(path)) return undefined;
  const r = JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
  if (r.kind !== 'mip0018-run-record' || r.schema !== 1) throw new RecordError(`${path} is not a version-1 mip0018 run record`);
  return r;
}

export function saveRecord(path: string, r: RunRecord): void {
  r.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${toJson(r)}\n`);
  renameSync(tmp, path);
}

export function findStep(r: RunRecord, id: string): StepRecord | undefined {
  return r.steps.find((s) => s.id === id);
}

export function upsertStep(r: RunRecord, s: Omit<StepRecord, 'state' | 'attempts' | 'startedAt'>): StepRecord {
  const existing = findStep(r, s.id);
  if (existing) return existing;
  const step: StepRecord = { ...s, state: 'pending', attempts: [], startedAt: new Date().toISOString() };
  r.steps.push(step);
  return step;
}

export function note(step: StepRecord, event: string): void {
  step.attempts.push({ at: new Date().toISOString(), event });
}
