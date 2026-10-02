#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Checks docs/conformance-matrix.md against the pinned MIP: every MUST/SHOULD
// sentence of the MIP has exactly one row with the same ID, section and text,
// and the matrix has no extra rows.
//
//   node tools/check-conformance-matrix.mjs          # check
//   node tools/check-conformance-matrix.mjs --print  # print the extracted rows (to seed the matrix)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPinnedMip, repoRoot } from './lib/mip.mjs';
import { extractRequirements, normalize } from './lib/requirements.mjs';

const { text, sha256, mip } = await loadPinnedMip();
if (sha256 !== mip.sha256) {
  console.error(`FAIL the cached MIP text does not match the pin (${sha256}); run npm run check:mip-pin`);
  process.exit(1);
}
const expected = extractRequirements(text);
const esc = (s) => s.replace(/\|/gu, '\\|');

if (process.argv.includes('--print')) {
  for (const r of expected) console.log(`| ${r.id} | ${esc(r.section)} | ${r.level} | ${esc(r.text)} | | planned |`);
  process.exit(0);
}

const rows = new Map();
const matrix = readFileSync(join(repoRoot, 'docs', 'conformance-matrix.md'), 'utf8');
for (const line of matrix.split('\n')) {
  const m = /^\|\s*(C-\d{3})\s*\|/u.exec(line);
  if (!m) continue;
  const cells = line
    .slice(1, -1)
    .split(/(?<!\\)\|/u)
    .map((c) => c.trim());
  rows.set(m[1], { section: normalize(cells[1] ?? ''), level: cells[2], text: normalize(cells[3] ?? '') });
}

const problems = [];
for (const r of expected) {
  const row = rows.get(r.id);
  if (!row) problems.push(`${r.id} missing: ${r.text}`);
  else if (row.text !== r.text || row.section !== normalize(r.section) || row.level !== r.level)
    problems.push(`${r.id} differs from the MIP text (section/level/text): ${r.text}`);
}
for (const id of rows.keys()) if (!expected.some((r) => r.id === id)) problems.push(`${id} is not a MUST/SHOULD of the pinned MIP`);

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`OK ${expected.length} MUST/SHOULD requirements of MIP-0018 @ ${mip.commit.slice(0, 7)} each have one row`);
