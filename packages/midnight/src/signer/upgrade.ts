// SPDX-License-Identifier: Apache-2.0
//
// Existing-contract upgrade (MIP-0018 "Backwards Compatibility Assessment — Existing contracts"; S6): add an
// emitting circuit to an already-deployed contract with a maintenance VerifierKeyInsert, then call it. Same address,
// same domainSep, same color, same coins.
//
//   1. compile an upgrade-only source: the deployed contract's ledger declarations verbatim + the new circuit
//   2. preflight (this file; reads only): the new circuit has a full-key build; every OTHER provable circuit of the
//      upgrade build is already on chain with the same key (midnight-js refuses to call through a compiled contract
//      whose circuits are not all on chain); the compiler's ledger layouts of the deployed build and the upgrade build
//      are identical; the deployed state decodes identically through both builds' ledger() accessors
//   3. insertVerifierKeyStep (contracts.ts): authority check, VerifierKeyInsert (v4 slot for ZKIR v3, Q23), after-check
//   4. callStep through the upgrade build (contracts.ts, CallInput.artifacts)
//
// Every check result is public (state values, hashes) and is kept in the run record's `contract.upgrades`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Indexer } from '../indexer.ts';
import { compareLayouts, decodeDeployedLedger, decodedDifferences, readLayout, type DecodedField } from '../layout.ts';
import type { ContractAdapter } from './adapter.ts';
import { StepError, verifierKeyHashes, type Run } from './contracts.ts';
import { onChainVerifierKey, currentContractState } from './maintenance.ts';
import type { CompiledArtifacts } from './providers.ts';
import type { UpgradeEntry } from './records.ts';
import { readProtectedFile } from './secrets.ts';
import type { SigningKey } from '@midnightntwrk/ledger-v9';

export interface UpgradeSource {
  artifacts: CompiledArtifacts;
  adapter?: ContractAdapter;
  /** Portable path of the adapter module, when there is one. */
  adapterPath?: string;
}

export interface UpgradePreflight {
  ok: boolean;
  /** Reasons to refuse (nothing is submitted unless forced). */
  problems: string[];
  notes: string[];
  verifierKey: Uint8Array;
  verifierKeySha256: string;
  layout?: ReturnType<typeof compareLayouts>;
  decoded?: { deployedBuild?: DecodedField[]; upgradeBuild: DecodedField[]; differences: string[] };
  otherCircuits: { name: string; onChain: 'same key' | 'other key' | 'absent' }[];
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Provable (non-pure) circuits of a compactc build. */
export function provableCircuits(managedDir: string): string[] {
  const info = JSON.parse(readFileSync(join(managedDir, 'compiler', 'contract-info.json'), 'utf8')) as {
    circuits?: { name: string; pure?: boolean; proof?: boolean }[];
  };
  return (info.circuits ?? []).filter((c) => !c.pure && c.proof !== false).map((c) => c.name);
}

/** Reads a maintenance signing key file (mode 0600): JSON {"tag": "schnorr"|"ecdsa", "value": "<hex>"} or bare hex (schnorr). */
export function readMaintenanceKeyFile(path: string): SigningKey {
  const text = readProtectedFile(path).toString('utf8').trim();
  let key: { tag?: unknown; value?: unknown };
  try {
    key = text.startsWith('{') ? (JSON.parse(text) as typeof key) : { tag: 'schnorr', value: text };
  } catch {
    throw new Error(`${path}: not a maintenance key file (JSON {tag, value} or hex)`);
  }
  if ((key.tag !== 'schnorr' && key.tag !== 'ecdsa') || typeof key.value !== 'string' || !/^([0-9a-f]{2})+$/iu.test(key.value))
    throw new Error(`${path}: not a maintenance key file (JSON {tag: "schnorr"|"ecdsa", value: hex} or hex)`);
  return { tag: key.tag, value: key.value.toLowerCase() };
}

/**
 * Read-only checks before a VerifierKeyInsert of `circuit` from the upgrade build into the run's deployed contract.
 * `run.o.artifacts` is the deployed contract's build (from its record).
 */
export async function preflightUpgrade(run: Run, src: UpgradeSource, circuit: string): Promise<UpgradePreflight> {
  const address = run.record.contract.address;
  if (!address) throw new StepError('the record has no contract address: deploy first', 'refused');
  const problems: string[] = [];
  const notes: string[] = [];
  const up = src.artifacts.managedDir;

  // 1. the new circuit, built with keys
  const vkFile = join(up, 'keys', `${circuit}.verifier`);
  if (!provableCircuits(up).includes(circuit)) throw new StepError(`${src.artifacts.name} has no provable circuit ${circuit}`, 'refused');
  if (!existsSync(vkFile)) throw new StepError(`${vkFile} is missing: compile the upgrade source WITH keys (not --skip-zk)`, 'refused');
  const verifierKey = Uint8Array.from(readFileSync(vkFile));

  // 2. every other provable circuit of the upgrade build must already be on chain with the same key
  const stateRow = await new Indexer(run.o.ep.profile.indexer, run.o.ep.profile.indexerWs).contractState(address);
  if (!stateRow) throw new StepError(`contract ${address} is not on chain`, 'refused');
  const state = await currentContractState(run.o.ep.profile, address);
  const hashes = verifierKeyHashes(up);
  const otherCircuits = provableCircuits(up)
    .filter((c) => c !== circuit)
    .map((name) => {
      const k = onChainVerifierKey(state, name);
      return { name, onChain: !k ? ('absent' as const) : sha256(k) === hashes[name] ? ('same key' as const) : ('other key' as const) };
    });
  for (const c of otherCircuits.filter((x) => x.onChain !== 'same key'))
    problems.push(
      `the upgrade build also exports ${c.name} (${c.onChain} on chain): midnight-js would refuse to call through it — export only the inserted circuit(s)`,
    );

  // 3. compiled ledger layouts
  let layout: UpgradePreflight['layout'];
  try {
    layout = compareLayouts(readLayout(run.o.artifacts.managedDir), readLayout(up));
    problems.push(...layout.problems.map((p) => `ledger layout ${p}`));
    notes.push(...layout.notes);
  } catch (e) {
    notes.push(`compiled layout not compared: ${(e as Error).message}`);
  }

  // 4. the deployed state through both accessors
  let decoded: UpgradePreflight['decoded'];
  try {
    const upgradeBuild = await decodeDeployedLedger(up, stateRow.state);
    let deployedBuild: DecodedField[] | undefined;
    try {
      deployedBuild = await decodeDeployedLedger(run.o.artifacts.managedDir, stateRow.state);
    } catch (e) {
      notes.push(`deployed build's accessor unavailable (${(e as Error).message}); check the decoded values by eye`);
    }
    const differences = deployedBuild ? decodedDifferences(deployedBuild, upgradeBuild) : [];
    problems.push(...differences.map((d) => `deployed state decodes differently: ${d}`));
    decoded = { ...(deployedBuild ? { deployedBuild } : {}), upgradeBuild, differences };
  } catch (e) {
    problems.push(`the upgrade build cannot decode the deployed state: ${(e as Error).message}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    notes,
    verifierKey,
    verifierKeySha256: sha256(verifierKey),
    ...(layout ? { layout } : {}),
    ...(decoded ? { decoded } : {}),
    otherCircuits,
  };
}

/** Records (or refreshes) the upgrade in the run record so later `publish` calls find the upgrade build. */
export function recordUpgrade(
  run: Run,
  src: UpgradeSource,
  circuit: string,
  slot: 'v3' | 'v4',
  pf: UpgradePreflight,
  portable: (p: string) => string,
): UpgradeEntry {
  const entry: UpgradeEntry = {
    circuit,
    slot,
    contract: src.artifacts.name,
    managedDir: portable(src.artifacts.managedDir),
    ...(src.adapterPath ? { adapter: src.adapterPath } : {}),
    verifierKeySha256: pf.verifierKeySha256,
    checks: {
      at: new Date().toISOString(),
      ok: pf.ok,
      problems: pf.problems,
      notes: pf.notes,
      layout: pf.layout?.rows,
      decoded: pf.decoded?.upgradeBuild,
      otherCircuits: pf.otherCircuits,
    },
  };
  const list = (run.record.contract.upgrades ??= []);
  const i = list.findIndex((u) => u.circuit === circuit);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  run.save();
  return entry;
}

/** The upgrade build that serves `circuit` for this record, if any. */
export function upgradeFor(run: { record: Run['record'] }, circuit: string): UpgradeEntry | undefined {
  return run.record.contract.upgrades?.find((u) => u.circuit === circuit);
}
