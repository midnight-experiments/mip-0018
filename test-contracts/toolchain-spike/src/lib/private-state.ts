// SPDX-License-Identifier: Apache-2.0
//
// A minimal private-state provider for contracts without private state.
//
// It keeps contract maintenance signing keys (the only secret midnight-js
// stores here for these contracts) in one JSON file of mode 0600, written
// atomically, so a maintenance update (e.g. VerifierKeyRemove) can still be
// signed after a restart. With no path it keeps everything in memory.
// The file must live outside every Git working tree.

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SigningKey } from '@midnightntwrk/ledger-v9';
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { readProtectedFile } from './secrets.js';

type Stored = { signingKeys: Record<string, SigningKey>; states: Record<string, Record<string, unknown>> };

const unsupported = (what: string) => () => Promise.reject(new Error(`${what} is not supported by this provider`));

export const filePrivateStateProvider = (path?: string): PrivateStateProvider => {
  let data: Stored = { signingKeys: {}, states: {} };
  if (path && existsSync(path)) data = JSON.parse(readProtectedFile(path).toString('utf8')) as Stored;
  let address = '';

  const save = () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  const scope = () => (data.states[address] ??= {});

  return {
    setContractAddress(a) {
      address = String(a);
    },
    set(id, state) {
      scope()[id] = state;
      save();
      return Promise.resolve();
    },
    get(id) {
      return Promise.resolve((scope()[id] as never) ?? null);
    },
    remove(id) {
      delete scope()[id];
      save();
      return Promise.resolve();
    },
    clear() {
      data.states = {};
      save();
      return Promise.resolve();
    },
    setSigningKey(a, key) {
      data.signingKeys[String(a)] = key;
      save();
      return Promise.resolve();
    },
    getSigningKey(a) {
      return Promise.resolve(data.signingKeys[String(a)] ?? null);
    },
    removeSigningKey(a) {
      delete data.signingKeys[String(a)];
      save();
      return Promise.resolve();
    },
    clearSigningKeys() {
      data.signingKeys = {};
      save();
      return Promise.resolve();
    },
    exportPrivateStates: unsupported('exportPrivateStates'),
    importPrivateStates: unsupported('importPrivateStates'),
    exportSigningKeys: unsupported('exportSigningKeys'),
    importSigningKeys: unsupported('importSigningKeys'),
  } as PrivateStateProvider;
};
