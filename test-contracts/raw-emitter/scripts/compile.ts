// SPDX-License-Identifier: Apache-2.0
//   node scripts/compile.ts          # TypeScript only (--skip-zk)
//   node scripts/compile.ts --keys   # with prover/verifier keys
import { compileRawEmitter } from '../src/contract.ts';

const keys = process.argv.includes('--keys');
const t = Date.now();
process.stdout.write(
  `RawEmitter: ${compileRawEmitter({ skipZk: !keys })} (${keys ? 'with keys' : '--skip-zk'}, ${Math.round((Date.now() - t) / 1000)} s)\n`,
);
