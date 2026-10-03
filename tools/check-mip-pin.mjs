#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Fetches the MIP text at the pinned commit (no cache) and checks its SHA-256
// against toolchain.json; checks that README.md cites the same commit and hash
// and links the MIP proposal; checks that every other copy of the pin agrees
// with toolchain.json: the vector manifest, every vector's `mip.commit`, the
// vector schemas, the vector tools and every Stagenet case's `mip.commit`; and
// that no tracked file cites another commit of the MIP text (a link into the
// MIP repository naming another commit, or any other commit of the proposal or
// of the file, listed by the GitHub API). A positive control plants such a
// citation first and must be caught.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foreignMipCitations, mipTextCommits } from './lib/mip-citations.mjs';
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
// Every Stagenet case cites the pin (deployments/stagenet/cases/<ID>/case.json).
const casesDir = join(repoRoot, 'deployments', 'stagenet', 'cases');
const cases = readdirSync(casesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(casesDir, e.name, 'case.json')))
  .map((e) => e.name);
if (cases.length === 0) problems.push('no Stagenet case.json found under deployments/stagenet/cases');
const staleCases = cases.filter(
  (id) => JSON.parse(read(join('deployments', 'stagenet', 'cases', id, 'case.json'))).mip?.commit !== mip.commit,
);
if (staleCases.length > 0) problems.push(`${staleCases.length} Stagenet case(s) cite another MIP commit: ${staleCases.join(', ')}`);

const common = read('vectors/tools/common.ts');
if (!common.includes(`commit: '${mip.commit}'`) || !common.includes(`sha256: '${mip.sha256}'`))
  problems.push('vectors/tools/common.ts (MIP constant used by the generator) does not carry the pinned commit and SHA-256');

// No tracked file cites another commit of the MIP text.
const others = (await mipTextCommits(mip)).filter((c) => c !== mip.commit);
if (others.length === 0) problems.push('the GitHub API listed no other commit of the MIP text: the citation check has nothing to test');
else {
  // Positive control: a planted citation of another commit (abbreviated, and as a link) must be found.
  const planted = `MIP text \`${others[0].slice(0, 7)}\`; https://github.com/${mip.repository}/blob/${others[0]}/${mip.path}`;
  const caught = foreignMipCitations(planted, mip.commit, others);
  if (caught.length !== 2)
    problems.push(`positive control: a planted citation of ${others[0].slice(0, 7)} was not caught (${caught.length}/2)`);
  if (foreignMipCitations(`MIP text \`${mip.commit.slice(0, 7)}\``, mip.commit, others).length !== 0)
    problems.push('positive control: a citation of the pin itself was flagged');
}
const tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { stdio: ['ignore', 'pipe', 'ignore'] })
  .toString()
  .split('\0')
  .filter((f) => f && !f.endsWith('.bin'));
let scanned = 0;
for (const file of tracked) {
  const path = join(repoRoot, file);
  if (!existsSync(path)) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue; // binary
  scanned++;
  for (const h of foreignMipCitations(bytes.toString('utf8'), mip.commit, others))
    problems.push(`${file}:${h.line} cites MIP commit ${h.sha} (${h.how}); the repository cites only the pin ${mip.commit.slice(0, 7)}`);
}
if (scanned === 0) problems.push('git ls-files listed no file to scan for MIP citations');

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(
  `OK MIP-0018 @ ${mip.commit} sha256 ${sha256}; README, vector manifest, ${manifest.vectors.length} vectors, schemas, generator and ${cases.length} Stagenet cases agree; ` +
    `${scanned} tracked files cite no other commit of the MIP text (${others.length} known; positive control caught)`,
);
