#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Fetches the MIP text at the pinned commit (no cache) and checks its SHA-256
// against toolchain.json; checks that README.md and MIP-PROPOSAL-NOTES.md cite
// the same commit and hash and link PR #340 (Q12).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPinnedMip, repoRoot } from './lib/mip.mjs';

const { sha256, mip } = await loadPinnedMip({ useCache: false });
const problems = [];
if (sha256 !== mip.sha256) problems.push(`MIP text at ${mip.commit} hashes to ${sha256}, toolchain.json pins ${mip.sha256}`);
for (const file of ['README.md', 'MIP-PROPOSAL-NOTES.md']) {
  const text = readFileSync(join(repoRoot, file), 'utf8');
  if (!text.includes(mip.commit)) problems.push(`${file} does not cite the pinned commit ${mip.commit}`);
  if (!text.includes(mip.sha256)) problems.push(`${file} does not cite the pinned SHA-256 ${mip.sha256}`);
}
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
if (!readme.includes(mip.pullRequest)) problems.push(`README.md does not link ${mip.pullRequest}`);

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`OK MIP-0018 @ ${mip.commit} sha256 ${sha256}`);
