// SPDX-License-Identifier: Apache-2.0
//
// Ledger layout check (upgrade template, examples/upgrade-existing-contract): does an upgrade-only source read the
// deployed contract's state at the same places? Wallet-free; compiling a source needs `compact` (toolchain image).
//
// Compact assigns each ledger field (the contract's own and those of imported modules) a state path by
// declaration order. A circuit compiled from another source reads and writes the deployed state through ITS
// paths, so the upgrade source must declare the same fields, in the same order, with the same storage and types.
// The compiler states the layout it chose in compiler/contract-info.json (`ledger`: name, index, storage, type),
// so this check compares the compiler's own view of the two sources, field by field — not a re-implementation of
// Compact's rules. `exported` is reported but not compared: it only decides whether the generated TypeScript
// `ledger()` accessor shows the field (module fields that are not exported still occupy their place).
//
// Field NAMES are compared too although a path does not depend on them: a renamed field at the same place almost
// always means a different field was put there, and the on-chain check (`mip0018 upgrade` decodes the deployed
// state with both sources' accessors) relies on equal names.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LedgerField {
  name: string;
  index: number;
  exported?: boolean;
  storage: string;
  [detail: string]: unknown;
}

export interface Layout {
  /** Where it was read from (managed dir or source file). */
  from: string;
  compiler: string;
  language: string;
  fields: LedgerField[];
}

export interface LayoutRow {
  index: number;
  legacy?: string;
  upgrade?: string;
  same: boolean;
}

export interface LayoutComparison {
  identical: boolean;
  rows: LayoutRow[];
  problems: string[];
  notes: string[];
}

type ContractInfo = { 'compiler-version'?: string; 'language-version'?: string; ledger?: LedgerField[] };

/** Reads the layout the compiler recorded in <managed dir>/compiler/contract-info.json. */
export function readLayout(managedDir: string): Layout {
  const p = join(managedDir, 'compiler', 'contract-info.json');
  if (!existsSync(p)) throw new Error(`${p} not found: not a compactc output directory`);
  const info = JSON.parse(readFileSync(p, 'utf8')) as ContractInfo;
  if (!Array.isArray(info.ledger))
    throw new Error(`${p} has no "ledger" section (compiler ${info['compiler-version'] ?? '?'}); compare with a newer compactc`);
  return {
    from: managedDir,
    compiler: info['compiler-version'] ?? '?',
    language: info['language-version'] ?? '?',
    fields: [...info.ledger].sort((a, b) => a.index - b.index),
  };
}

/** Compiles a source with --skip-zk into a temporary directory and reads its layout (needs `compact` on PATH). */
export function layoutOfSource(source: string, o: { compactPath?: string } = {}): Layout {
  const out = mkdtempSync(join(tmpdir(), 'mip0018-layout-'));
  try {
    const args = ['compile', '--feature-zkir-v3', '--skip-zk'];
    if (o.compactPath) args.push('--compact-path', o.compactPath);
    args.push(source, out);
    try {
      execFileSync('compact', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      throw new Error(`compact ${args.join(' ')} failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: e });
    }
    return { ...readLayout(out), from: source };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A source file is compiled; a directory is read as compactc output. */
export function layoutOf(path: string, o: { compactPath?: string } = {}): Layout {
  return statSync(path).isDirectory() ? readLayout(path) : layoutOfSource(path, o);
}

/** Compact-like rendering of a contract-info type. */
export function typeText(t: unknown): string {
  if (t === undefined) return '';
  const x = t as Record<string, unknown>;
  switch (x['type-name']) {
    case 'Bytes':
      return `Bytes<${String(x.length)}>`;
    case 'Uint': {
      const max = Number(x.maxval);
      const bits = Math.log2(max + 1);
      return Number.isInteger(bits) ? `Uint<${bits}>` : `Uint<0..${String(x.maxval)}>`;
    }
    case 'Boolean':
    case 'Field':
      return String(x['type-name']);
    case 'Opaque':
      return `Opaque<"${String(x.tsType)}">`;
    case 'Vector':
      return `Vector<${String(x.length)}, ${typeText(x.type)}>`;
    case 'Struct':
    case 'Enum':
      return String(x.name);
    default:
      return JSON.stringify(t);
  }
}

/** `name: Storage<…>` for a ledger field. */
export function fieldText(f: LedgerField): string {
  const inner = [f.key, f.value ?? f.type].filter((v) => v !== undefined).map(typeText);
  return `${f.name}: ${f.storage}${inner.length > 0 ? `<${inner.join(', ')}>` : ''}`;
}

/** Canonical JSON of what decides the place and the encoding of a field (everything but `exported`). */
const signature = (f: LedgerField): string => {
  const { exported: _e, ...rest } = f;
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(canon(rest));
};

export function compareLayouts(legacy: Layout, upgrade: Layout): LayoutComparison {
  const problems: string[] = [];
  const notes: string[] = [];
  const rows: LayoutRow[] = [];
  const n = Math.max(legacy.fields.length, upgrade.fields.length);
  for (let i = 0; i < n; i++) {
    const a = legacy.fields[i];
    const b = upgrade.fields[i];
    const same = a !== undefined && b !== undefined && signature(a) === signature(b);
    rows.push({
      index: i,
      ...(a ? { legacy: fieldText(a) } : {}),
      ...(b ? { upgrade: fieldText(b) } : {}),
      same,
    });
    if (same) {
      if (a!.exported !== b!.exported)
        notes.push(`#${i} ${a!.name}: exported ${String(a!.exported)} vs ${String(b!.exported)} (no effect on the layout)`);
      continue;
    }
    if (!a) problems.push(`#${i}: the upgrade declares an extra field ${fieldText(b!)} that the deployed contract does not have`);
    else if (!b) problems.push(`#${i}: the upgrade lacks the deployed field ${fieldText(a)}`);
    else if (a.name !== b.name && signature({ ...a, name: '' }) === signature({ ...b, name: '' }))
      problems.push(
        `#${i}: renamed (${a.name} → ${b.name}); a field of the same type in another order or under another name reads a different value`,
      );
    else problems.push(`#${i}: deployed ${fieldText(a)}, upgrade ${fieldText(b)}`);
  }
  if (legacy.compiler !== upgrade.compiler)
    notes.push(
      `compiled by different compilers (deployed: ${legacy.compiler}, upgrade: ${upgrade.compiler}); also run the on-chain decode check (mip0018 upgrade does)`,
    );
  return { identical: problems.length === 0, rows, problems, notes };
}

// ------------------------------------------------------------------------------------- on-chain decode check

export interface DecodedField {
  name: string;
  /** Typed JSON of the value (bytes as hex, bigints as strings); ADTs other than cells/counters by size. */
  value: unknown;
}

const jsonOf = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonOf);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown> & { size?: () => unknown; isEmpty?: () => unknown };
    if (typeof o.size === 'function') return { size: jsonOf(o.size()) };
    if (typeof o.isEmpty === 'function') return { isEmpty: o.isEmpty() };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, jsonOf(x)]));
  }
  return v;
};

/**
 * Decodes a deployed contract's ledger state (the indexer's `contractAction.state`, hex) with the generated
 * `ledger()` accessor of a compiled source, for every exported field of that source. A source whose layout does
 * not match the deployed one either fails here or shows other values under the same names.
 */
export async function decodeDeployedLedger(managedDir: string, stateHex: string): Promise<DecodedField[]> {
  const { pathToFileURL } = await import('node:url');
  const rt = await import('@midnight-ntwrk/compact-runtime');
  const mod = (await import(pathToFileURL(join(managedDir, 'contract', 'index.js')).href)) as {
    ledger?: (s: unknown) => Record<string, unknown>;
  };
  if (!mod.ledger) throw new Error(`${managedDir}: the compiled contract has no ledger() accessor`);
  const state = rt.ContractState.deserialize(Uint8Array.from(Buffer.from(stateHex.replace(/^0x/u, ''), 'hex')));
  const view = mod.ledger(state.data);
  return readLayout(managedDir)
    .fields.filter((f) => f.exported !== false)
    .map((f) => {
      try {
        return { name: f.name, value: jsonOf(view[f.name]) };
      } catch (e) {
        return { name: f.name, value: { error: String((e as Error)?.message ?? e).slice(0, 200) } };
      }
    });
}

/** Names whose decoded values differ (or exist on one side only). */
export function decodedDifferences(a: DecodedField[], b: DecodedField[]): string[] {
  const m = new Map(b.map((f) => [f.name, JSON.stringify(f.value)]));
  const out: string[] = [];
  for (const f of a) {
    const other = m.get(f.name);
    if (other === undefined) out.push(`${f.name}: only in the deployed contract's accessor`);
    else if (other !== JSON.stringify(f.value))
      out.push(`${f.name}: deployed accessor ${JSON.stringify(f.value)}, upgrade accessor ${other}`);
    m.delete(f.name);
  }
  for (const name of m.keys()) out.push(`${name}: only in the upgrade's accessor`);
  return out;
}
