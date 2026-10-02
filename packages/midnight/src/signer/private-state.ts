// SPDX-License-Identifier: Apache-2.0
//
// A file-backed midnight-js PrivateStateProvider for the signer.
//
// It holds the two kinds of secrets midnight-js keeps per contract: the contract maintenance signing key and the
// contract's private state (e.g. an OpenZeppelin `Ownable` owner secret used by the `wit_OwnableSK` witness). Both
// live in ONE JSON file of mode 0600 inside the signer's private state directory (outside every Git tree), written
// atomically on every change. Values are encoded with a typed JSON (`{"$bytes": hex}`, `{"$bigint": "…"}`) so byte
// arrays and bigints survive a restart. With no path everything stays in memory. Never printed.

import { existsSync } from 'node:fs';
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { readProtectedFile, writeProtectedFile } from './secrets.ts';

type Stored = { signingKeys: Record<string, unknown>; states: Record<string, Record<string, unknown>> };

export function encodeTyped(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('hex') };
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (Array.isArray(v)) return v.map(encodeTyped);
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encodeTyped(k), encodeTyped(x)]) };
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeTyped(x)]));
  return v;
}

export function decodeTyped(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeTyped);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$bytes === 'string') return Uint8Array.from(Buffer.from(o.$bytes, 'hex'));
    if (keys.length === 1 && typeof o.$bigint === 'string') return BigInt(o.$bigint);
    if (keys.length === 1 && Array.isArray(o.$map))
      return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [decodeTyped(k), decodeTyped(x)]));
    return Object.fromEntries(keys.map((k) => [k, decodeTyped(o[k])]));
  }
  return v;
}

const unsupported = (what: string) => () => Promise.reject(new Error(`${what} is not supported by this provider`));

export interface FilePrivateStateProvider extends PrivateStateProvider {
  /** Stores a private state for a given contract address without changing the provider's current address. */
  setFor(address: string, id: string, state: unknown): Promise<void>;
  /** Whether a signing key is stored for the address. */
  hasSigningKey(address: string): boolean;
}

export const filePrivateStateProvider = (path?: string): FilePrivateStateProvider => {
  let data: Stored = { signingKeys: {}, states: {} };
  if (path && existsSync(path)) data = decodeTyped(JSON.parse(readProtectedFile(path).toString('utf8'))) as Stored;
  let address = '';
  const save = () => {
    if (path) writeProtectedFile(path, JSON.stringify(encodeTyped(data)));
  };
  const scope = (a = address) => (data.states[a] ??= {});

  const p = {
    setContractAddress(a: unknown) {
      address = String(a);
    },
    set(id: string, state: unknown) {
      scope()[id] = state;
      save();
      return Promise.resolve();
    },
    setFor(a: string, id: string, state: unknown) {
      scope(a)[id] = state;
      save();
      return Promise.resolve();
    },
    get(id: string) {
      return Promise.resolve((scope()[id] as never) ?? null);
    },
    remove(id: string) {
      delete scope()[id];
      save();
      return Promise.resolve();
    },
    clear() {
      data.states = {};
      save();
      return Promise.resolve();
    },
    setSigningKey(a: unknown, key: unknown) {
      data.signingKeys[String(a)] = key;
      save();
      return Promise.resolve();
    },
    getSigningKey(a: unknown) {
      return Promise.resolve((data.signingKeys[String(a)] as never) ?? null);
    },
    hasSigningKey(a: string) {
      return data.signingKeys[a] !== undefined;
    },
    removeSigningKey(a: unknown) {
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
  };
  return p as unknown as FilePrivateStateProvider;
};
