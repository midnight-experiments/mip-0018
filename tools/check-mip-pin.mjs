#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Fetches the MIP text at the pinned commit (no cache) and checks its SHA-256
// against toolchain.json; checks that README.md cites
// the same commit and hash and that README.md links PR #340 (Q12); checks that
// every other copy of the pin agrees with toolchain.json: the vector manifest,
// every vector's `mip.commit`, the vector schemas and the vector tools.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPinnedMip, repoRoot } from './lib/mip.mjs';

const { sha256, mip } = await loadPinnedMip({ useCache: false });
const problems = [];
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
if (sha256 !== mip.sha256) problems.push(`MIP text at ${mip.commit} hashes to ${sha256}, toolchain.json pins ${mip.sha256}`);
for (const file of ['README.md']) {
  const text = read(file);
  if (!text.includes(mip.commit)) problems.push(`${file} does not cite the pinned commit ${mip.commit}`);
  if (!text.includes(mip.sha256)) problems.push(`${file} does not cite the pinned SHA-256 ${mip.sha256}`);
}
if (!read('README.md').includes(mip.pullRequest)) problems.push(`README.md does not link ${mip.pullRequest}`);

// The vectors carry their own copy of the pin (manifest, every vector, schemas, generator constants).
const manifest = JSON.parse(read('vectors/manifest.json'));
if (manifest.mip?.commit !== mip.commit || manifest.mip?.sha256 !== mip.sha256)
  problems.push(
    `vectors/manifest.json pins ${manifest.mip?.commit} / ${manifest.mip?.sha256}, toolchain.json ${mip.commit} / ${mip.sha256}`,
  );
const stale = manifest.vectors.filter((v) => JSON.parse(read(join('vectors', v.file))).mip?.commit !== mip.commit).map((v) => v.id);
if (stale.length > 0) problems.push(`${stale.length} vector(s) cite another MIP commit: ${stale.join(', ')}`);
const schemaPins = [
  ['vectors/schema/payload.schema.json', (s) => s.$defs.mipRef.properties.commit.const],
  ['vectors/schema/manifest.schema.json', (s) => s.properties.mip.properties.commit.const],
];
for (const [file, pick] of schemaPins) {
  const pinned = pick(JSON.parse(read(file)));
  if (pinned !== mip.commit) problems.push(`${file} pins commit ${pinned}, toolchain.json ${mip.commit}`);
}
const common = read('vectors/tools/common.ts');
if (!common.includes(`commit: '${mip.commit}'`) || !common.includes(`sha256: '${mip.sha256}'`))
  problems.push('vectors/tools/common.ts (MIP constant used by the generator) does not carry the pinned commit and SHA-256');

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(
  `OK MIP-0018 @ ${mip.commit} sha256 ${sha256}; README, vector manifest, ${manifest.vectors.length} vectors, schemas and generator agree`,
);
