// SPDX-License-Identifier: Apache-2.0
//
// Reading a file that holds a secret (a wallet mnemonic or seed, a Blockfrost project token). Error messages name
// the file, never its content.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

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
