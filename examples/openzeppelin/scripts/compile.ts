// SPDX-License-Identifier: Apache-2.0
//
// Compiles the OpenZeppelin examples (both versions of each contract: with and without metadata)
// with Compact 0.35.0 and --feature-zkir-v3 against @openzeppelin/compact-contracts 0.4.0-alpha.5.
//
//   node scripts/compile.ts                          # all, TypeScript/ZKIR only (--skip-zk)
//   node scripts/compile.ts --keys                   # all, with prover/verifier keys
//   node scripts/compile.ts --keys native-shielded   # one example
//   node scripts/compile.ts --keys --with-metadata-only native-shielded   # only the contract to deploy (mip0018 CLI)
import { compileExample, EXAMPLE_NAMES, type ExampleName, type Variant } from '../src/examples.ts';

const args = process.argv.slice(2);
const keys = args.includes('--keys');
const variants: Variant[] = args.includes('--with-metadata-only') ? ['with-metadata'] : ['without-metadata', 'with-metadata'];
const names = args.filter((a) => !a.startsWith('--')) as ExampleName[];
for (const example of names.length > 0 ? names : EXAMPLE_NAMES) {
  if (!EXAMPLE_NAMES.includes(example)) throw new Error(`unknown example ${example}; one of ${EXAMPLE_NAMES.join(', ')}`);
  for (const variant of variants) {
    const t = Date.now();
    const dir = compileExample(example, { variant, skipZk: !keys });
    process.stdout.write(
      `${example} (${variant}): ${dir} (${keys ? 'with keys' : '--skip-zk'}, ${Math.round((Date.now() - t) / 1000)} s)\n`,
    );
  }
}
