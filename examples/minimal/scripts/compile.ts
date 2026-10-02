// SPDX-License-Identifier: Apache-2.0
//
// Compiles the minimal example contracts with Compact 0.35.0 and --feature-zkir-v3.
//
//   node scripts/compile.ts                       # all, TypeScript only (--skip-zk)
//   node scripts/compile.ts --keys                # all, with prover/verifier keys
//   node scripts/compile.ts --keys CreateAndDestroy
import { CONTRACTS, compileMinimal, type MinimalContract } from '../src/contracts.ts';

const args = process.argv.slice(2);
const keys = args.includes('--keys');
const names = args.filter((a) => !a.startsWith('--')) as MinimalContract[];
for (const name of names.length > 0 ? names : CONTRACTS) {
  if (!CONTRACTS.includes(name)) throw new Error(`unknown contract ${name}; one of ${CONTRACTS.join(', ')}`);
  const t = Date.now();
  const dir = compileMinimal(name, { skipZk: !keys });
  process.stdout.write(`${name}: ${dir} (${keys ? 'with keys' : '--skip-zk'}, ${Math.round((Date.now() - t) / 1000)} s)\n`);
}
