// SPDX-License-Identifier: Apache-2.0
// TEST-ONLY raw emitter: build, witnesses, constructor argument.
import { join } from 'node:path';
import { ensureCompiled } from '@mip0018/compact/testing';

export const PACKAGE_DIR = join(import.meta.dirname, '..');
export const MANAGED_DIR = join(PACKAGE_DIR, 'managed', 'RawEmitter');
const REPO = join(PACKAGE_DIR, '..', '..');

/** Compiles contracts/RawEmitter.compact (OpenZeppelin imports resolve through <repo>/node_modules). */
export const compileRawEmitter = (o: { skipZk?: boolean } = {}): string =>
  ensureCompiled(join(PACKAGE_DIR, 'contracts', 'RawEmitter.compact'), MANAGED_DIR, {
    skipZk: o.skipZk ?? true,
    compactPath: join(REPO, 'node_modules'),
  });

/** Private state: the caller's OpenZeppelin `Ownable` secret key (read by `wit_OwnableSK`). */
export type RawEmitterPrivateState = { ownableSecretKey: Uint8Array };

export const witnesses = {
  wit_OwnableSK: ({ privateState }: { privateState: RawEmitterPrivateState }): [RawEmitterPrivateState, Uint8Array] => [
    privateState,
    privateState.ownableSecretKey,
  ],
};

/** The constructor's `initialOwner` for an account id (OpenZeppelin `Either<Bytes<32>, ContractAddress>`, left). */
export const ownerArg = (accountId: Uint8Array) => ({ is_left: true, left: accountId, right: { bytes: new Uint8Array(32) } });
