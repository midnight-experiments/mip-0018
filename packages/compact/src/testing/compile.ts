// SPDX-License-Identifier: Apache-2.0
//
// Compiles a Compact source with the pinned compiler (Compact 0.35.0, --feature-zkir-v3) unless an
// up-to-date build already exists. Used by the tests (TypeScript only: --skip-zk) and by the cost
// measurement (full keys). Runs inside the toolchain image (docker/run.sh), where `compact` is on PATH.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const COMPACT_VERSION = '0.35.0';

/** Newest mtime (ms) of a file or of every *.compact file under a directory. */
const newest = (path: string): number => {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'managed') continue;
    const p = join(path, e.name);
    if (e.isDirectory()) m = Math.max(m, newest(p));
    else if (e.name.endsWith('.compact')) m = Math.max(m, statSync(p).mtimeMs);
  }
  return m;
};

export type CompileOptions = {
  /** Generate only the TypeScript/ZKIR output (no prover/verifier keys). Default true. */
  skipZk?: boolean;
  /** Files or directories whose *.compact files the source depends on (imported modules). */
  dependsOn?: readonly string[];
  /** Colon-separated Compact path for package imports (e.g. "<repo>/node_modules"). */
  compactPath?: string;
  /** Recompile even if the output looks current. */
  force?: boolean;
};

/** The marker that tells whether a build has keys: a full build writes managed/<c>/keys/. */
export const hasKeys = (outDir: string): boolean => existsSync(join(outDir, 'keys'));

/**
 * Compiles `source` into `outDir` (managed/<Contract>) if the output is missing or older than the
 * source or its dependencies. A full-key build satisfies a --skip-zk request; the reverse does not.
 * Concurrent callers are safe: each compiles into a private directory that is renamed into place.
 */
export const ensureCompiled = (source: string, outDir: string, o: CompileOptions = {}): string => {
  const skipZk = o.skipZk ?? true;
  const index = join(outDir, 'contract', 'index.js');
  const inputs = Math.max(newest(source), ...(o.dependsOn ?? []).map(newest));
  if (!o.force && existsSync(index) && statSync(index).mtimeMs >= inputs && (skipZk || hasKeys(outDir))) return outDir;

  const tmp = join(dirname(outDir), `.${basename(outDir)}.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(dirname(outDir), { recursive: true });
  const args = ['compile', '--feature-zkir-v3'];
  if (skipZk) args.push('--skip-zk');
  if (o.compactPath) args.push('--compact-path', o.compactPath);
  args.push(source, tmp);
  try {
    execFileSync('compact', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`compact ${args.join(' ')} failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: e });
  }
  rmSync(outDir, { recursive: true, force: true });
  try {
    renameSync(tmp, outDir);
  } catch {
    // Another process installed its build first; ours is identical.
    rmSync(tmp, { recursive: true, force: true });
  }
  return outDir;
};

/** Runs the compiler on a source expected to FAIL and returns its message (throws if it compiles). */
export const compileError = (source: string, o: Pick<CompileOptions, 'compactPath'> = {}): string => {
  const tmp = join(dirname(source), `.compile-fail-${process.pid}-${Date.now()}`);
  const args = ['compile', '--feature-zkir-v3', '--skip-zk'];
  if (o.compactPath) args.push('--compact-path', o.compactPath);
  args.push(source, tmp);
  try {
    execFileSync('compact', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  throw new Error(`${source} compiled, but a compile error was expected`);
};
