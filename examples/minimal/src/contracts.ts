// SPDX-License-Identifier: Apache-2.0
// The minimal example contracts and how to build them.
import { join } from 'node:path';
import { ensureCompiled } from '@mip0018/compact/testing';

export const EXAMPLE_DIR = join(import.meta.dirname, '..');
export const CONTRACTS_DIR = join(EXAMPLE_DIR, 'contracts');
export const MANAGED_DIR = join(EXAMPLE_DIR, 'managed');
const MODULE_DIR = join(EXAMPLE_DIR, '..', '..', 'packages', 'compact', 'src');

export const CONTRACTS = ['CreateAndDestroy', 'OwnerKey', 'PublishOnce'] as const;
export type MinimalContract = (typeof CONTRACTS)[number];

/** Compiles contracts/<name>.compact into managed/<name> if needed (TypeScript only unless skipZk: false). */
export const compileMinimal = (name: MinimalContract, o: { skipZk?: boolean } = {}): string =>
  ensureCompiled(join(CONTRACTS_DIR, `${name}.compact`), join(MANAGED_DIR, name), {
    skipZk: o.skipZk ?? true,
    dependsOn: [CONTRACTS_DIR, MODULE_DIR],
  });

/** Private state of these contracts: the caller's secret key (read by the `secretKey` witness). */
export type MinimalPrivateState = { secretKey: Uint8Array };

export const witnesses = {
  secretKey: ({ privateState }: { privateState: MinimalPrivateState }): [MinimalPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};
