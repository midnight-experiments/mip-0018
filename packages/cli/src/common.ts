// SPDX-License-Identifier: Apache-2.0
//
// Shared CLI plumbing: option parsing, network profiles, output (fixed-width text or --json), exit codes, logging.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolveProfile, toJson, type EndpointOverrides, type NetworkProfile } from '@mip0018/midnight';

export class UsageError extends Error {
  override name = 'UsageError';
}

/** Exit codes shared by every command. */
export const EXIT = {
  ok: 0,
  /** verify: mismatch · signer commands: failed or refused · lookup: — */
  failed: 1,
  usage: 2,
  /** verify: not found · lookup: color not in the scanned range */
  notFound: 3,
  /** verify: not yet indexed / final · signer commands: outcome unknown, re-run to reconcile */
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
  'min-interval-ms': { type: 'string' },
};

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
  return (msg, extra) => process.stderr.write(`${new Date().toISOString()} ${msg}${extra === undefined ? '' : ` ${toJson(extra, 0)}`}\n`);
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

export const KIND_NAME: Record<number, string> = { 1: 'native shielded', 2: 'native unshielded', 3: 'ledger' };
