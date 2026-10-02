// SPDX-License-Identifier: Apache-2.0
//
// Compiles the upgrade template's contracts with Compact 0.35.0 and --feature-zkir-v3 into managed/<name>.
//
//   node scripts/compile.ts                         # both, with prover/verifier keys (what deploy and upgrade need)
//   node scripts/compile.ts --skip-zk               # both, TypeScript/ZKIR only (tests)
//   node scripts/compile.ts LegacyTokenMetadata     # one of them
import { CONTRACTS, compile, type ContractName } from '../src/contracts.ts';

const args = process.argv.slice(2);
const skipZk = args.includes('--skip-zk');
const force = args.includes('--force');
const names = args.filter((a) => !a.startsWith('--')) as ContractName[];
for (const name of names.length > 0 ? names : (Object.keys(CONTRACTS) as ContractName[])) {
  if (!(name in CONTRACTS)) throw new Error(`unknown contract ${name}; one of ${Object.keys(CONTRACTS).join(', ')}`);
  const t = Date.now();
  const dir = compile(name, { skipZk, force });
  process.stdout.write(`${name}: ${dir} (${skipZk ? '--skip-zk' : 'with keys'}, ${Math.round((Date.now() - t) / 1000)} s)\n`);
}
