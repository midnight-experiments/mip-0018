// SPDX-License-Identifier: Apache-2.0
//
// Reading wallet secrets. Secrets are only ever given as file PATHS, read here,
// and never printed: every error message below names the file, never its content.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** Reads a protected file: a regular file (not a symlink), not readable by group or others. */
export const readProtectedFile = (path: string): Buffer => {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error(`${path}: refusing a symbolic link`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path}: not a regular file`);
    if ((st.mode & 0o077) !== 0) throw new Error(`${path}: mode must not grant group/other access (chmod 600)`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Reads a BIP-39 mnemonic file (12-24 English words) and returns the 64-byte
 * BIP-39 seed (empty passphrase) — the master seed of a Lace-compatible wallet.
 */
export const seedFromMnemonicFile = (path: string): Uint8Array => {
  const words = readProtectedFile(path).toString('utf8').trim().toLowerCase().split(/\s+/u);
  if (words.length < 12 || words.length > 24) {
    throw new Error(`${path}: expected 12-24 mnemonic words, found ${words.length}`);
  }
  const phrase = words.join(' ');
  if (!validateMnemonic(phrase, wordlist)) throw new Error(`${path}: not a valid BIP-39 English mnemonic`);
  return mnemonicToSeedSync(phrase);
};

/** Reads a hex seed file (local test wallets only). */
export const seedFromHexFile = (path: string): Uint8Array => {
  const hex = readProtectedFile(path).toString('utf8').trim();
  if (!/^([0-9a-f]{2}){16,64}$/iu.test(hex)) throw new Error(`${path}: expected a hex seed`);
  return Buffer.from(hex, 'hex');
};
