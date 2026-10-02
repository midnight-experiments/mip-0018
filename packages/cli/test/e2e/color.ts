// SPDX-License-Identifier: Apache-2.0
// Prints tokenType(domainSep, contractAddress) — the expected colors of the local end-to-end test.
//   node packages/cli/test/e2e/color.ts <domainSep hex> <contract address hex>
import { tokenTypeHex } from '@mip0018/midnight';

const [ds, addr] = process.argv.slice(2);
if (!ds || !addr) throw new Error('usage: color.ts <domainSep> <contractAddress>');
process.stdout.write(`${tokenTypeHex(ds, addr)}\n`);
