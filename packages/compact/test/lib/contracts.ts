// SPDX-License-Identifier: Apache-2.0
// Test contracts of packages/compact and how to build them (TypeScript only unless keys are asked for).
import { join } from 'node:path';
import { ensureCompiled } from '../../src/testing/index.ts';

export const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
export const SRC_DIR = join(PACKAGE_DIR, 'src');
export const CONTRACTS_DIR = join(PACKAGE_DIR, 'test', 'contracts');
export const MANAGED_DIR = join(PACKAGE_DIR, 'managed');

/** The two constructions (owner decision Q3): the default typed builders and the pure-circuit alternative. */
export const CONSTRUCTIONS = [
  { label: 'typed constructor (default, Mip0018.compact)', contract: 'VectorsTyped', module: 'Mip0018' },
  { label: 'pure circuits (alternative, Mip0018Pure.compact)', contract: 'VectorsPure', module: 'Mip0018Pure' },
] as const;

/** Compiles test/contracts/<name>.compact into managed/<name> if needed and returns that directory. */
export const compileTestContract = (name: string, o: { skipZk?: boolean; source?: string } = {}): string =>
  ensureCompiled(o.source ?? join(CONTRACTS_DIR, `${name}.compact`), join(MANAGED_DIR, name), {
    skipZk: o.skipZk ?? true,
    dependsOn: [SRC_DIR],
  });
