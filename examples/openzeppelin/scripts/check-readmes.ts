// SPDX-License-Identifier: Apache-2.0
//
// Checks that every "add these lines" block of the OpenZeppelin example READMEs matches the sources:
// `readme-diff` blocks must equal the diff between the contract without and with metadata,
// `readme-snippet` blocks must appear in the named file (src/readme-diff.ts).
//
//   node scripts/check-readmes.ts          # check (exit 1 on any difference)
//   node scripts/check-readmes.ts --fix    # rewrite the diff blocks from the sources
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NAMES, OZ_DIR } from '../src/examples.ts';
import { checkReadme } from '../src/readme-diff.ts';

const fix = process.argv.includes('--fix');
const readmes = [join(OZ_DIR, 'README.md'), ...EXAMPLE_NAMES.map((e) => join(OZ_DIR, e, 'README.md'))].filter((p) => existsSync(p));
let failed = 0;
for (const readme of readmes) {
  const { problems, blocks } = checkReadme(readme, { fix });
  for (const p of problems) process.stderr.write(`FAIL ${p.readme}:${p.line} ${p.message}\n`);
  failed += problems.length;
  process.stdout.write(
    `${problems.length === 0 ? 'OK  ' : 'FAIL'} ${readme.slice(OZ_DIR.length + 1)} (${blocks} checked blocks${fix ? ', diffs rewritten' : ''})\n`,
  );
}
process.exit(failed === 0 ? 0 : 1);
