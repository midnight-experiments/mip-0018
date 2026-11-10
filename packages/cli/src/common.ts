// SPDX-License-Identifier: Apache-2.0
//
// Shared CLI plumbing: option parsing, network profiles, output (fixed-width text or --json), exit codes, logging.
// Log lines and error messages go through `scrubSecrets` (URLs without their query string, no registered token);
// `guardOutput` (@mip0018/midnight) filters everything the process writes through `removeSecrets` (no registered
// token, nothing else changed — metadata values are printed exactly). A command that acts on a recorded file (a run
// record, a scanner state, a case folder) binds its profile to the identity the file and its case folder's network
// file record (`boundProfile`) before its first request.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  PROFILE_IDS,
  ProfileError,
  agreeRecordedNetworks,
  profileForFiles,
  resolveProfile,
  scrubSecrets,
  toJson,
  type EndpointOverrides,
  type NetworkProfile,
  type RecordedNetwork,
  type RecordedSource,
} from '@mip0018/midnight';

export { guardOutput } from '@mip0018/midnight';

export class UsageError extends Error {
  override name = 'UsageError';
}

/** Exit codes shared by every command. */
export const EXIT = {
  ok: 0,
  /** check-event: mismatch · signer commands: failed or refused · lookup: — */
  failed: 1,
  usage: 2,
  /** check-event: not found · lookup: color not in the scanned range */
  notFound: 3,
  /** check-event: not yet indexed / final · signer commands: outcome unknown, re-run to reconcile */
  pending: 4,
} as const;

type Options = NonNullable<ParseArgsConfig['options']>;

export const NETWORK_OPTIONS: Options = {
  network: { type: 'string' },
  indexer: { type: 'string' },
  'indexer-ws': { type: 'string' },
  rpc: { type: 'string' },
  'rpc-ws': { type: 'string' },
  genesis: { type: 'string' },
  'chain-instance': { type: 'string' },
  'blockfrost-token-file': { type: 'string' },
  'min-interval-ms': { type: 'string' },
};

/** The network options as usage text (every command that takes --network shows it). */
export const NETWORK_USAGE = `
network (every command that reads the chain):
  --network <${PROFILE_IDS.join('|')}>
      preview     public endpoints (Midnight-hosted), no token
      preprod     Blockfrost endpoints: the project token of a Midnight Preprod project from MIP0018_BLOCKFROST_PREPROD
                  or --blockfrost-token-file <0600 file>; without one the command stops before any request
      mainnet     Blockfrost endpoints: the same with MIP0018_BLOCKFROST_MAINNET
      undeployed  a local chain: --indexer <url> --rpc <url> (or MIP0018_INDEXER_URL / MIP0018_NODE_URL), optional
                  --genesis <hash>; public endpoints and public genesis hashes are refused
  --indexer / --indexer-ws / --rpc / --rpc-ws <url>   other endpoints (no query string; the genesis stays pinned)
  --chain-instance <hash>   also require this block-1 hash (refuses a network re-created from the same genesis)
  --min-interval-ms <n>     politeness interval between requests (public networks: 250)
`;

export const OUTPUT_OPTIONS: Options = {
  json: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

export type Values = Record<string, string | boolean | string[] | undefined>;

export function parse(argv: string[], options: Options, usage: string): Values {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { ...options, ...OUTPUT_OPTIONS },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument(s): ${positionals.join(' ')}`);
    if (values.help) {
      process.stdout.write(`${usage.trim()}\n`);
      process.exit(EXIT.ok);
    }
    return values as Values;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${(e as Error).message}\n\n${usage.trim()}`);
  }
}

export function str(v: Values, name: string, required = false): string | undefined {
  const x = v[name];
  if (x === undefined || x === '') {
    if (required) throw new UsageError(`--${name} is required`);
    return undefined;
  }
  if (typeof x !== 'string') throw new UsageError(`--${name} expects a value`);
  return x;
}

export function int(v: Values, name: string, required = false): number | undefined {
  const s = str(v, name, required);
  if (s === undefined) return undefined;
  if (!/^\d+$/u.test(s)) throw new UsageError(`--${name} expects a non-negative integer`);
  return Number(s);
}

export function profileFrom(v: Values): NetworkProfile {
  const id = str(v, 'network', true)!;
  const o: EndpointOverrides = {};
  const set = (k: keyof EndpointOverrides, flag: string) => {
    const x = str(v, flag);
    if (x !== undefined) (o as Record<string, unknown>)[k] = x;
  };
  set('indexer', 'indexer');
  set('indexerWs', 'indexer-ws');
  set('rpc', 'rpc');
  set('rpcWs', 'rpc-ws');
  set('genesisHash', 'genesis');
  set('chainInstance', 'chain-instance');
  set('tokenFile', 'blockfrost-token-file');
  const mi = int(v, 'min-interval-ms');
  if (mi !== undefined) o.minIntervalMs = mi;
  try {
    return resolveProfile(id, o);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** Reads inline JSON or `@file`. */
export function jsonArg(v: Values, name: string): unknown {
  const s = str(v, name);
  if (s === undefined) return undefined;
  const text = s.startsWith('@') ? readFileSync(s.slice(1), 'utf8') : s;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--${name}: not valid JSON (${(e as Error).message})`);
  }
}

export function logger(v: Values): (msg: string, extra?: unknown) => void {
  if (v.quiet) return () => {};
  return (msg, extra) =>
    process.stderr.write(scrubSecrets(`${new Date().toISOString()} ${msg}${extra === undefined ? '' : ` ${toJson(extra, 0)}`}\n`));
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${toJson(value)}\n`);
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** `key  value` lines with a fixed key column. */
export function kv(rows: [string, string][], width = 12): void {
  for (const [k, val] of rows) out(`${k.padEnd(width)}${val}`);
}

export const short = (hex: string, n = 8) => (hex.length > 2 * n + 1 ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex);

/** Repository root: the nearest ancestor with toolchain.json (the CLI runs from a checkout). */
export function repoRoot(): string {
  let dir = resolve(import.meta.dirname, '..', '..', '..');
  try {
    dir = realpathSync(dir);
  } catch {
    /* keep */
  }
  return dir;
}

/** A path made relative to the repository when inside it (records stay portable between host and container). */
export function portablePath(p: string): string {
  const root = repoRoot();
  const abs = isAbsolute(p) ? p : resolve(p);
  const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
}

export function fromPortable(p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot(), p);
}

export const KIND_NAME: Record<number, string> = { 1: 'shielded UTXO', 2: 'unshielded UTXO', 3: 'contract token' };

/** The public facts of a run record the wallet-free commands use (read as plain JSON: no signer code). */
export interface RecordInfo {
  path: string;
  network: RecordedNetwork & { genesisHash: string };
  contract: { name: string; address?: string };
  steps: {
    id: string;
    kind: string;
    circuit?: string;
    state: string;
    tx?: { hash: string };
    inclusion?: { height: number; hash: string; status: string; fee?: string };
    expectedEvents?: unknown[];
  }[];
}

export function readRecord(path: string): RecordInfo {
  let r: RecordInfo & { kind?: string; schema?: number };
  try {
    r = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`--record ${path}: ${(e as Error).message}`);
  }
  if (r.kind !== 'mip0018-run-record' || r.schema !== 1) throw new UsageError(`${path} is not a version-1 mip0018 run record`);
  return { ...r, path };
}

/**
 * The profile bound to the identity recorded by files and by the network file of the case folder each path lies in
 * (`profileForFiles`): another network, another genesis or another chain instance is refused (exit 2) before any
 * request; what the profile lacks is taken from them, so its identity check verifies the recorded chain.
 */
export function boundProfile(profile: NetworkProfile, paths: readonly string[], recorded: readonly RecordedSource[] = []): NetworkProfile {
  try {
    return profileForFiles(profile, paths, recorded);
  } catch (e) {
    if (e instanceof ProfileError) throw new UsageError(e.message);
    throw e;
  }
}

/** Refuses (exit 2) files that record different chains (`agreeRecordedNetworks`). */
export function agreeingFiles(recorded: readonly RecordedSource[]): void {
  try {
    agreeRecordedNetworks(recorded);
  } catch (e) {
    if (e instanceof ProfileError) throw new UsageError(e.message);
    throw e;
  }
}

/** The recorded network of a run record, as a binding source. */
export const recordSource = (r: RecordInfo): RecordedSource => ({ source: r.path, network: r.network });

/**
 * The contract of a run record and the profile to read it with: bound to the record's network and its case folder's
 * network file (`boundProfile`).
 */
export function recordTarget(r: RecordInfo, profile: NetworkProfile): { profile: NetworkProfile; address: string } {
  const bound = boundProfile(profile, [r.path], [recordSource(r)]);
  if (!r.contract.address) throw new UsageError(`${r.path} has no contract address (not deployed)`);
  return { profile: bound, address: r.contract.address };
}

/** The step of a record whose transaction to check: `--step`, or the only call step with logged events. */
export function recordStep(r: RecordInfo, stepId?: string): { id: string; tx: string } {
  if (stepId !== undefined) {
    const s = r.steps.find((x) => x.id === stepId);
    if (!s) throw new UsageError(`${r.path} has no step "${stepId}" (steps: ${r.steps.map((x) => x.id).join(', ')})`);
    if (!s.tx?.hash) throw new UsageError(`step "${stepId}" of ${r.path} has no transaction (state ${s.state})`);
    return { id: s.id, tx: s.tx.hash };
  }
  const c = r.steps.filter((x) => x.kind === 'call' && x.tx?.hash && (x.expectedEvents?.length ?? 0) > 0);
  if (c.length !== 1)
    throw new UsageError(`give --step: ${r.path} has ${c.length} call steps with events (${c.map((x) => x.id).join(', ') || 'none'})`);
  return { id: c[0]!.id, tx: c[0]!.tx!.hash };
}
