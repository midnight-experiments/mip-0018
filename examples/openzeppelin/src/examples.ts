// SPDX-License-Identifier: Apache-2.0
// The OpenZeppelin examples, their contracts and how to build them.
//
// Every example has two versions of one contract:
//   <example>/contracts/without-metadata/<Contract>.compact  the OpenZeppelin token you start from
//   <example>/contracts/<Contract>.compact                   the same token with MIP-0018 metadata
// The README of each example shows the difference as a diff (checked by scripts/check-readmes.ts).
// OpenZeppelin and the MIP-0018 module are imported by package path, resolved through
// `--compact-path <repo>/node_modules`.
import { join } from 'node:path';
import { ensureCompiled } from '@mip0018/compact/testing';

export const OZ_DIR = join(import.meta.dirname, '..');
export const REPO = join(OZ_DIR, '..', '..');
const MODULE_DIR = join(REPO, 'packages', 'compact', 'src');
const OZ_PACKAGE_DIR = join(REPO, 'node_modules', '@openzeppelin', 'compact-contracts');

export const EXAMPLES = {
  'fungible-token': { contract: 'MyFungibleToken' },
  'native-shielded': { contract: 'MyShieldedToken' },
  'native-unshielded': { contract: 'MyUnshieldedToken' },
  'multi-kind': { contract: 'MyMultiKindToken' },
  'token-family': { contract: 'MyTokenFamily' },
} as const;
export type ExampleName = keyof typeof EXAMPLES;
export const EXAMPLE_NAMES = Object.keys(EXAMPLES) as ExampleName[];

export type Variant = 'with-metadata' | 'without-metadata';

export const exampleDir = (example: ExampleName): string => join(OZ_DIR, example);

/** The contract source of an example (`with-metadata` = the one to deploy). */
export const contractSource = (example: ExampleName, variant: Variant = 'with-metadata'): string => {
  const c = EXAMPLES[example].contract;
  return variant === 'with-metadata'
    ? join(exampleDir(example), 'contracts', `${c}.compact`)
    : join(exampleDir(example), 'contracts', 'without-metadata', `${c}.compact`);
};

/** Where `compact compile` writes an example's contract: <example>/managed/<Contract>[-without-metadata]. */
export const managedDir = (example: ExampleName, variant: Variant = 'with-metadata'): string => {
  const c = EXAMPLES[example].contract;
  return join(exampleDir(example), 'managed', variant === 'with-metadata' ? c : `${c}-without-metadata`);
};

/**
 * Compiles an example contract with the pinned compiler (Compact 0.35.0, --feature-zkir-v3) if its
 * output is missing or stale. TypeScript only (--skip-zk) unless `skipZk: false`.
 */
export const compileExample = (example: ExampleName, o: { variant?: Variant; skipZk?: boolean } = {}): string => {
  const variant = o.variant ?? 'with-metadata';
  return ensureCompiled(contractSource(example, variant), managedDir(example, variant), {
    skipZk: o.skipZk ?? true,
    dependsOn: [join(exampleDir(example), 'contracts'), MODULE_DIR, OZ_PACKAGE_DIR],
    compactPath: join(REPO, 'node_modules'),
  });
};
