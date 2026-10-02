// SPDX-License-Identifier: Apache-2.0
//
// Signing commands: wallet status|register-dust, deploy, publish, remove-circuit, deploy-and-publish.
// They run in the signer container (docker/signer.sh); the wallet secret is a FILE path, read once, never printed.
// Run records are public (no secret); maintenance keys and witness private state go to the 0600 private-state file
// in the signer's state directory (outside the repository).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { checkIdentity, normAddress, verifyEmission, type EventExpectation } from '@mip0018/midnight';
import {
  StepError,
  callStep,
  closeWallet,
  deployStep,
  describeWallet,
  exampleAdapterPath,
  loadAdapter,
  loadRecord,
  masterSeed,
  openRun,
  openWallet,
  registerDust,
  removeVerifierKeyStep,
  signerContext,
  waitForSync,
  type CompiledArtifacts,
  type ContractAdapter,
  type MetadataInput,
  type Run,
  type SignerEndpoints,
  type StepRecord,
  type WalletSession,
} from '@mip0018/midnight/signer';
import {
  EXIT,
  NETWORK_OPTIONS,
  UsageError,
  emitJson,
  fromPortable,
  jsonArg,
  kv,
  logger,
  out,
  parse,
  portablePath,
  profileFrom,
  readRecord,
  repoRoot,
  short,
  str,
  type Values,
} from './common.ts';
import { printVerify } from './wallet-free.ts';

const SIGNER_OPTIONS = {
  ...NETWORK_OPTIONS,
  'proof-server': { type: 'string' },
  'wallet-proof-server': { type: 'string' },
  'mnemonic-file': { type: 'string' },
  'seed-file': { type: 'string' },
  'dev-genesis-wallet': { type: 'boolean', default: false },
  'state-dir': { type: 'string' },
  'private-state': { type: 'string' },
  'wallet-cache': { type: 'string' },
} as const;

const SIGNER_HELP = `
Signer options (signer container only):
  --mnemonic-file <path>       BIP-39 mnemonic file, mode 0600 (or MIP0018_MNEMONIC_FILE)
  --seed-file <path>           hex seed file, local undeployed chains only (or MIP0018_SEED_FILE)
  --dev-genesis-wallet         the local dev chain's public genesis wallet (undeployed only)
  --proof-server <url>         contract circuits (or MIP0018_PROOF_SERVER_URL; official 9.0.0-rc.8, Q21)
  --wallet-proof-server <url>  DUST spends (or MIP0018_WALLET_PROOF_SERVER_URL; official 9.0.0-rc.6, Q21)
  --state-dir <dir>            private state directory outside the repository (or MIP0018_STATE_DIR)
  --private-state <file>       maintenance keys + witness private state (default <state-dir>/mip0018-private-state.json)
  --wallet-cache <file>        optional 0600 wallet sync cache outside the repository (restores the sub-wallets; on a
                               public network a re-run then syncs only the new blocks)
`;

function endpoints(v: Values): SignerEndpoints {
  const profile = profileFrom(v);
  const proofServer = str(v, 'proof-server') ?? process.env.MIP0018_PROOF_SERVER_URL;
  const walletProofServer = str(v, 'wallet-proof-server') ?? process.env.MIP0018_WALLET_PROOF_SERVER_URL ?? proofServer;
  if (!proofServer) throw new UsageError('--proof-server (or MIP0018_PROOF_SERVER_URL) is required: there is no public proof server');
  return { profile, proofServer, walletProofServer: walletProofServer! };
}

async function wallet(v: Values, ep: SignerEndpoints, log: (m: string, x?: unknown) => void): Promise<WalletSession> {
  const seed = masterSeed(
    {
      mnemonicFile: str(v, 'mnemonic-file') ?? (v['seed-file'] || v['dev-genesis-wallet'] ? undefined : process.env.MIP0018_MNEMONIC_FILE),
      seedFile: str(v, 'seed-file') ?? (v['mnemonic-file'] || v['dev-genesis-wallet'] ? undefined : process.env.MIP0018_SEED_FILE),
      devGenesis: v['dev-genesis-wallet'] === true,
    },
    ep.profile,
  );
  const cache = str(v, 'wallet-cache');
  if (cache !== undefined && !relative(repoRoot(), resolve(cache)).startsWith('..'))
    throw new UsageError(`${cache} is inside the repository; the wallet cache holds secrets`);
  log('opening the wallet and syncing (minutes on a public network)');
  return openWallet(ep, seed, { ...(cache ? { cachePath: resolve(cache) } : {}), log });
}

function privateStatePath(v: Values): string {
  const explicit = str(v, 'private-state');
  const dir = str(v, 'state-dir') ?? process.env.MIP0018_STATE_DIR;
  const p = explicit ?? (dir ? join(dir, 'mip0018-private-state.json') : undefined);
  if (!p) throw new UsageError('--state-dir (or MIP0018_STATE_DIR) is required: maintenance keys must be kept outside the repository');
  const rel = relative(repoRoot(), resolve(p));
  if (!rel.startsWith('..')) throw new UsageError(`${p} is inside the repository; private state must live outside it`);
  return resolve(p);
}

function exitFor(e: unknown): number {
  if (e instanceof StepError) return e.outcome === 'unknown' ? EXIT.pending : EXIT.failed;
  throw e;
}

function printStep(s: StepRecord): void {
  const tx = s.tx ? `tx ${short(s.tx.hash)}` : 'no tx';
  const inc = s.inclusion
    ? ` block ${s.inclusion.height} ${s.inclusion.status}${s.inclusion.fee ? ` fee ${s.inclusion.fee} SPECK` : ''}`
    : '';
  out(`  ${s.id.padEnd(34)} ${s.state.padEnd(10)} ${tx}${inc}${s.skipped ? `  (skipped: ${s.skipped})` : ''}`);
}

function printRun(run: Run, recordPath: string): void {
  const r = run.record;
  kv([
    ['record', recordPath],
    ['network', `${r.network.id}  genesis ${short(r.network.genesisHash, 6)}`],
    ['contract', `${r.contract.name}  ${r.contract.address ?? '(not deployed)'}`],
  ]);
  out('steps');
  for (const s of r.steps) printStep(s);
}

// ---------------------------------------------------------------------------------------------------------- wallet

export const WALLET_USAGE = `
mip0018 wallet status --network <id> [signer options] [--json]
mip0018 wallet register-dust --network <id> [--estimate] [signer options] [--json]

status: public addresses, NIGHT balance and UTxOs (registered for DUST or not), DUST balance — never a secret.
register-dust: registers every unregistered NIGHT UTxO for DUST generation (skipped when none; waits until the
registration is observed). --estimate only prints the fee.
${SIGNER_HELP}`;

export async function cmdWallet(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub !== 'status' && sub !== 'register-dust') throw new UsageError(WALLET_USAGE.trim());
  const v = parse(argv.slice(1), { ...SIGNER_OPTIONS, estimate: { type: 'boolean', default: false } }, WALLET_USAGE);
  const log = logger(v);
  const ep = endpoints(v);
  await checkIdentity(ep.profile);
  const session = await wallet(v, ep, log);
  try {
    if (sub === 'status') {
      const id = describeWallet(session, await waitForSync(session));
      if (v.json) emitJson({ network: ep.profile.id, ...id });
      else
        kv([
          ['network', ep.profile.id],
          ['unshielded', id.unshieldedAddress],
          ['shielded', id.shieldedAddress],
          ['dust addr', id.dustAddress],
          ['NIGHT', `${id.night} STAR in ${id.nightUtxos} UTxO(s), ${id.nightUtxosRegisteredForDust} registered for DUST`],
          ['DUST', `${id.dust} SPECK`],
        ]);
      if (!v.json) {
        for (const [t, b] of Object.entries(id.unshieldedBalances)) out(`unshielded  ${t}  ${b}`);
        for (const [t, b] of Object.entries(id.shieldedBalances)) out(`shielded    ${t}  ${b}`);
      }
      return EXIT.ok;
    }
    const r = await registerDust(session, { estimateOnly: v.estimate === true });
    if (v.json) emitJson(r);
    else
      kv([
        ['outcome', r.outcome],
        ['unregistered', String(r.unregistered)],
        ['fee', r.feeEstimate ? `${r.feeEstimate} SPECK` : '-'],
        ['tx', r.txId ?? '-'],
        ['DUST after', r.after?.dust ?? r.before.dust],
      ]);
    return EXIT.ok;
  } finally {
    await closeWallet(session);
  }
}

// ---------------------------------------------------------------------------------------- shared contract session

interface ContractSource {
  artifacts: CompiledArtifacts;
  adapter?: ContractAdapter;
  adapterPath?: string;
}

async function contractSource(v: Values, recordPath?: string): Promise<ContractSource> {
  let adapterPath = str(v, 'adapter');
  const example = str(v, 'example');
  if (example) adapterPath = exampleAdapterPath(repoRoot(), example);
  let managed = str(v, 'contract');
  if (!adapterPath && !managed && recordPath) {
    const rec = loadRecord(recordPath);
    if (!rec) throw new UsageError(`${recordPath} does not exist; deploy first`);
    if (rec.contract.adapter) adapterPath = fromPortable(rec.contract.adapter);
    else managed = fromPortable(rec.contract.managedDir);
  }
  if (adapterPath) {
    const a = await loadAdapter(adapterPath);
    return {
      artifacts: { name: a.adapter.contract.name, managedDir: a.managedDir },
      adapter: a.adapter,
      adapterPath: portablePath(a.path),
    };
  }
  if (!managed) throw new UsageError('give --contract <managed dir>, --adapter <file> or --example <name>');
  const dir = resolve(managed);
  if (!existsSync(join(dir, 'contract', 'index.js')))
    throw new UsageError(`${dir} is not a compactc output directory (no contract/index.js)`);
  return { artifacts: { name: basename(dir), managedDir: dir } };
}

/** A deploy or a call needs the compiled verifier keys (a `--skip-zk` build has none). */
function requireKeys(src: ContractSource): void {
  if (existsSync(join(src.artifacts.managedDir, 'keys'))) return;
  const c = src.adapter?.compile;
  const how = c
    ? `npm run -s ${c.script} -w ${c.workspace}${c.args?.length ? ` -- ${c.args.join(' ')}` : ''}`
    : 'compact compile (without --skip-zk)';
  throw new UsageError(`${src.artifacts.managedDir} has no keys/ (a --skip-zk build?): compile with keys first: ${how}`);
}

async function withRun<T>(v: Values, recordPath: string, src: ContractSource, f: (run: Run) => Promise<T>): Promise<T> {
  requireKeys(src);
  const log = logger(v);
  const ep = endpoints(v);
  const ps = privateStatePath(v);
  // Chain identity first: a wrong network aborts before any wallet is opened or anything is built.
  await checkIdentity(ep.profile);
  const session = await wallet(v, ep, log);
  try {
    const run = await openRun({
      ep,
      session,
      recordPath,
      artifacts: { ...src.artifacts, managedDir: src.artifacts.managedDir },
      privateStatePath: ps,
      adapter: src.adapter,
      adapterPath: src.adapterPath,
      log,
      force: v.force === true,
      crashAfterSubmit: process.env.MIP0018_TEST_CRASH_AFTER_SUBMIT,
    });
    run.record.contract.managedDir = portablePath(src.artifacts.managedDir);
    run.save();
    return await f(run);
  } finally {
    await closeWallet(session);
  }
}

// ---------------------------------------------------------------------------------------------------------- deploy

export const DEPLOY_USAGE = `
mip0018 deploy --network <id> (--contract <managed dir> | --adapter <file> | --example <name>) --record <file> [--args <json>]

Deploys a compiled contract with midnight-js deployContract. The record (public JSON) stores the contract address and
the transaction BEFORE submission; re-running the same command resumes: the before-check finds the contract on chain
and skips, a recorded transaction is reconciled from the chain (never resubmitted blindly). Completed only when the
indexer shows the contract with every compiled operation.

  --args <json|@file>   constructor arguments (typed JSON: "0x…" bytes, numbers → bigint, {"$utf8": "…", "pad": N})
${SIGNER_HELP}
Exit: 0 completed · 1 failed or refused (nothing submitted) · 2 usage · 4 outcome unknown (re-run to reconcile)
`;

export async function cmdDeploy(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...SIGNER_OPTIONS,
      contract: { type: 'string' },
      adapter: { type: 'string' },
      example: { type: 'string' },
      record: { type: 'string' },
      args: { type: 'string' },
    },
    DEPLOY_USAGE,
  );
  const recordPath = str(v, 'record', true)!;
  const args = (jsonArg(v, 'args') ?? []) as unknown[];
  if (!Array.isArray(args)) throw new UsageError('--args must be a JSON array');
  const src = await contractSource(v);
  return withRun(v, recordPath, src, async (run) => {
    try {
      await deployStep(run, args);
      return EXIT.ok;
    } catch (e) {
      logger(v)(`deploy: ${(e as Error).message}`);
      return exitFor(e);
    } finally {
      if (v.json) emitJson(run.record);
      else printRun(run, recordPath);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------- attach

/** `--attach <address|@record>` → the contract address (normalized). */
function attachAddress(v: Values): { address: string; from: string } | undefined {
  const a = str(v, 'attach');
  if (a === undefined) return undefined;
  if (a.startsWith('@')) {
    const r = readRecord(a.slice(1));
    if (!r.contract.address) throw new UsageError(`${a.slice(1)} has no contract address`);
    return { address: normAddress(r.contract.address), from: portablePath(a.slice(1)) };
  }
  try {
    return { address: normAddress(a), from: 'command line' };
  } catch (e) {
    throw new UsageError(`--attach: ${(e as Error).message}`);
  }
}

/** Binds a fresh record to an existing contract (it deploys nothing; the before-check still requires the contract). */
function attachRecord(run: Run, a: { address: string; from: string }, src: ContractSource): void {
  const c = run.record.contract;
  if (c.address !== undefined) {
    if (c.address !== a.address) throw new UsageError(`${run.o.recordPath} is bound to ${c.address}, not ${a.address}`);
    return;
  }
  if (run.record.steps.some((s) => s.kind === 'deploy'))
    throw new UsageError(`${run.o.recordPath} has a deploy step; --attach needs a new record`);
  c.address = a.address;
  c.attached = { from: a.from, at: new Date().toISOString() };
  const ad = src.adapter;
  const psId = ad?.privateStateId ?? (ad?.initialPrivateState ? src.artifacts.name : undefined);
  if (psId !== undefined) c.privateStateId = psId;
  run.save();
  run.log(`record attached to ${a.address} (from ${a.from})`);
}

// --------------------------------------------------------------------------------------------------------- publish

export const PUBLISH_USAGE = `
mip0018 publish --network <id> --record <file> --circuit <name> [--args <json>] [--step <id>] [--force]

Calls an emitting circuit of the recorded contract (midnight-js findDeployedContract(...).callTx.<circuit>()).
Before: the contract and the circuit's key exist; just before submission the finalized transaction's Misc events are
recorded and, unless --force, the step is skipped when the contract's metadata already holds exactly what they set.
After: completed only when exactly those events are observed in that transaction.

  --args <json|@file>   circuit arguments, converted with the compiler's types (Bytes<N>: hex or {"$utf8": "…"})
  --step <id>           step name (default circuit + hash of the arguments; reuse an id to resume it, use a new
                        id to publish the same arguments again)
  --force               skip the "already present" check (re-emit identical values on purpose)
  --attach <address|@record>  start a NEW record for a contract this record did not deploy (with --example,
                        --adapter or --contract): e.g. another signer calling an owner-only circuit; the signer's
                        own private state is used (a fresh one if it has none: not the owner)
  --adapter / --contract  override what the record names
  --args placeholders   {"$signer": "coinPublicKey" | "unshieldedAddress"}, {"$random": N}, {"$adapter": "<name>"}
${SIGNER_HELP}
Exit: 0 completed (or already present) · 1 failed or refused · 2 usage · 4 outcome unknown (re-run)
`;

export async function cmdPublish(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...SIGNER_OPTIONS,
      contract: { type: 'string' },
      adapter: { type: 'string' },
      example: { type: 'string' },
      record: { type: 'string' },
      circuit: { type: 'string' },
      args: { type: 'string' },
      step: { type: 'string' },
      attach: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    PUBLISH_USAGE,
  );
  const recordPath = str(v, 'record', true)!;
  const circuit = str(v, 'circuit', true)!;
  const args = (jsonArg(v, 'args') ?? []) as unknown[];
  if (!Array.isArray(args)) throw new UsageError('--args must be a JSON array');
  const attach = attachAddress(v);
  if (attach && !str(v, 'example') && !str(v, 'adapter') && !str(v, 'contract'))
    throw new UsageError('--attach needs --example, --adapter or --contract (what the contract is)');
  const src = await contractSource(v, attach ? undefined : recordPath);
  return withRun(v, recordPath, src, async (run) => {
    try {
      if (attach) attachRecord(run, attach, src);
      await callStep(run, { circuit, args, ...(str(v, 'step') ? { stepId: str(v, 'step')! } : {}) });
      return EXIT.ok;
    } catch (e) {
      logger(v)(`publish: ${(e as Error).message}`);
      return exitFor(e);
    } finally {
      if (v.json) emitJson(run.record);
      else printRun(run, recordPath);
    }
  });
}

// -------------------------------------------------------------------------------------------------- remove-circuit

export const REMOVE_USAGE = `
mip0018 remove-circuit --network <id> --record <file> --circuit <name> [--slot v4|v3]

Create-and-destroy (Q4): removes the circuit's verifier key with a maintenance VerifierKeyRemove signed by the
contract's maintenance key (from the private-state file). ZKIR-v3 keys live in the v4 slot (Q23; default).
Before: skipped when the key is already gone. After: completed only when the indexer shows the key gone.
${SIGNER_HELP}
Exit: 0 completed · 1 failed or refused · 2 usage · 4 outcome unknown (re-run)
`;

export async function cmdRemoveCircuit(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...SIGNER_OPTIONS,
      contract: { type: 'string' },
      adapter: { type: 'string' },
      record: { type: 'string' },
      circuit: { type: 'string' },
      slot: { type: 'string', default: 'v4' },
    },
    REMOVE_USAGE,
  );
  const recordPath = str(v, 'record', true)!;
  const circuit = str(v, 'circuit', true)!;
  const slot = str(v, 'slot') as 'v3' | 'v4';
  if (slot !== 'v3' && slot !== 'v4') throw new UsageError('--slot is v4 (ZKIR v3 circuits) or v3');
  const src = await contractSource(v, recordPath);
  return withRun(v, recordPath, src, async (run) => {
    try {
      await removeVerifierKeyStep(run, circuit, slot);
      return EXIT.ok;
    } catch (e) {
      logger(v)(`remove-circuit: ${(e as Error).message}`);
      return exitFor(e);
    } finally {
      if (v.json) emitJson(run.record);
      else printRun(run, recordPath);
    }
  });
}

// -------------------------------------------------------------------------------------------- deploy-and-publish

export const DAP_USAGE = `
mip0018 deploy-and-publish (--example <name> | --adapter <file>) [--metadata <json>] --network <id> --record <file>
                           [--compile] [--no-verify]

The request's "deploy + emit" in one command: compile (with keys, when managed/ has none or --compile) → deploy →
every call the example's adapter lists (e.g. mints, then the publish) → verify each emitting transaction
(wallet-free checks, expecting exactly the adapter's payloads). Each step is guarded by the before/after checks;
re-run the same command to resume. The example is examples/<name>, examples/openzeppelin/<name> or
test-contracts/<name> with a mip0018.adapter.ts.

  --metadata <json|@file>  {"domainSep": "0x…", "kind": 1|2|3, "name", "symbol", "decimals", "standards"} — for
                           examples whose values are compiled in (all of this repository's), it must equal the
                           example's own metadata (default) or the command is refused before anything runs
${SIGNER_HELP}`;

export async function cmdDeployAndPublish(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...SIGNER_OPTIONS,
      example: { type: 'string' },
      adapter: { type: 'string' },
      metadata: { type: 'string' },
      record: { type: 'string' },
      compile: { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
    DAP_USAGE,
  );
  const recordPath = str(v, 'record', true)!;
  if (!str(v, 'example') && !str(v, 'adapter')) throw new UsageError('--example <name> (or --adapter <file>) is required');
  const metadata = jsonArg(v, 'metadata') as MetadataInput | undefined;
  const src = await contractSource(v);
  const log = logger(v);
  const adapter = src.adapter!;
  // The adapter checks --metadata against what the contract can emit BEFORE anything is compiled or signed.
  const deployArgs = adapter.deployArgs?.(metadata) ?? [];
  const dir = src.artifacts.managedDir;
  if (v.compile || !existsSync(join(dir, 'contract', 'index.js')) || !existsSync(join(dir, 'keys'))) {
    const c = adapter.compile;
    if (!c) throw new UsageError(`${dir} has no keys and the adapter says nothing about compiling`);
    const args = ['run', '-s', c.script, '-w', c.workspace, ...(c.args?.length ? ['--', ...c.args] : [])];
    log(`compiling with keys: npm ${args.join(' ')}`);
    const r = spawnSync('npm', args, { cwd: repoRoot(), stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) return EXIT.failed;
  }
  return withRun(v, recordPath, src, async (run) => {
    let code: number = EXIT.ok;
    const verified: unknown[] = [];
    try {
      await deployStep(run, deployArgs, metadata);
      const ctx = { ...signerContext(run), metadata, contractAddress: run.record.contract.address };
      for (const p of adapter.publish?.(metadata, ctx) ?? []) {
        const step = await callStep(run, { circuit: p.circuit, args: p.args, ...(p.stepId ? { stepId: p.stepId } : {}) });
        if (v['no-verify'] || !step.tx) continue;
        let expect: EventExpectation[] | EventExpectation | undefined = p.expect;
        if (expect === undefined && metadata)
          expect = {
            metadata: {
              domainSep: metadata.domainSep,
              kind: metadata.kind,
              name: metadata.name,
              symbol: metadata.symbol,
              decimals: metadata.decimals,
              standards: metadata.standards,
            },
          };
        if (Array.isArray(expect) && expect.length === 0) continue; // emits nothing (e.g. a mint): the after-check saw zero events
        const r = await verifyEmission({
          profile: run.o.ep.profile,
          contract: run.record.contract.address!,
          tx: step.tx.hash,
          expect, // an array is checked event by event, including the count
          waitMs: 60_000,
        });
        verified.push(r);
        if (!v.json) printVerify(r);
        if (r.exitCode !== 0) code = r.exitCode;
      }
    } catch (e) {
      log(`deploy-and-publish: ${(e as Error).message}`);
      code = exitFor(e);
    } finally {
      if (v.json) emitJson({ record: run.record, verified });
      else printRun(run, recordPath);
    }
    return code;
  });
}

export const recordDir = (p: string) => dirname(resolve(p));
