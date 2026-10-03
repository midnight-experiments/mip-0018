// SPDX-License-Identifier: Apache-2.0
//
// Payload bytes for an example's metadata.json, from the reference encoder (@mip0018/codec):
//
//   node scripts/payload-hex.ts '{"domainSep":"0x…","kind":3,"name":"Acme Gold","symbol":"AGLD","decimals":6}'
//   node scripts/payload-hex.ts '{"domainSep":"0x…","kind":3,"withdraw":true}'   # Null at name, symbol, decimals, standards
//   node scripts/payload-hex.ts --pad 'mip-0018:example:fungible'      # 0x-hex of pad(32, text)
//   node scripts/payload-hex.ts --fill fungible-token/metadata.json    # (re)write every event's "payload"
//
// The tests check that every "payload" equals this encoding AND the bytes the contract emits.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toHex } from '@mip0018/codec';
import { REPO } from '../src/examples.ts';
import { encodeExpected, pad32, type ExampleMetadata, type ExpectedEvent } from '../src/testing.ts';

const [first, second] = process.argv.slice(2);
if (first === '--pad' && second !== undefined) {
  process.stdout.write(`0x${toHex(pad32(second))}\n`);
} else if (first === '--fill' && second !== undefined) {
  const path = resolve(second);
  const m = JSON.parse(readFileSync(path, 'utf8')) as ExampleMetadata;
  let n = 0;
  for (const step of [...m.steps, ...m.lifecycle])
    for (const e of step.events) {
      e.payload = toHex(encodeExpected(e));
      n++;
    }
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  const prettier = spawnSync(join(REPO, 'node_modules', '.bin', 'prettier'), ['--write', path], { encoding: 'utf8' });
  if (prettier.status !== 0) throw new Error(`prettier failed: ${prettier.stderr}`);
  process.stdout.write(`${path}: ${n} payloads\n`);
} else if (first !== undefined) {
  process.stdout.write(`${toHex(encodeExpected(JSON.parse(first) as ExpectedEvent))}\n`);
} else {
  throw new Error('usage: payload-hex.ts <event JSON> | --pad <text> | --fill <metadata.json>');
}
