// SPDX-License-Identifier: Apache-2.0
//
// The pinned MIP-0018 text: fetched from the pinned commit (never copied into the
// repository, Q12), cached under .cache/ and checked against toolchain.json.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const toolchain = () => JSON.parse(readFileSync(join(repoRoot, 'toolchain.json'), 'utf8'));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Downloads the pinned MIP text (or reads the cache) and returns { bytes, text, sha256, mip }. */
export const loadPinnedMip = async ({ useCache = true } = {}) => {
  const mip = toolchain().mip;
  const cache = join(repoRoot, '.cache', 'mip', `${mip.commit}.md`);
  let bytes;
  if (useCache && existsSync(cache)) {
    bytes = readFileSync(cache);
  } else {
    let lastError;
    for (let attempt = 1; attempt <= 3 && !bytes; attempt++) {
      try {
        const res = await fetch(mip.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${mip.url}`);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!bytes) throw lastError;
  }
  const digest = sha256(bytes);
  if (digest === mip.sha256 && useCache && !existsSync(cache)) {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, bytes);
  }
  return { bytes, text: bytes.toString('utf8'), sha256: digest, mip };
};
