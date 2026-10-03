// SPDX-License-Identifier: Apache-2.0
//
// Records the Stagenet exchanges the unit tests replay (read-only queries against the public indexer and node RPC,
// at most 4 requests per second). Subject: the toolchain-spike contract (recorded case SPIKE,
// test-contracts/toolchain-spike/records/stagenet.json): deploy 710806, publishMetadata 710810 (MIP-0018 A1),
// VerifierKeyRemove 710814.
//
//   docker/run.sh exec 'node packages/midnight/test/fixtures/record-stagenet.ts'
//
// Writes packages/midnight/test/fixtures/stagenet/*.json (tapes + the reports they produced at recording time).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../../src/http.ts';
import { stagenetProfile } from '../../src/network.ts';
import { verifyEmission } from '../../src/verify.ts';
import { listMetadata } from '../../src/list.ts';
import { scan } from '../../src/scanner.ts';
import { toJson } from '../../src/hex.ts';
import { recordingFetch, saveTape, type Exchange } from '../support/cassette.ts';
import { writeFileSync } from 'node:fs';

const out = join(import.meta.dirname, 'stagenet');
mkdirSync(out, { recursive: true });
const profile = stagenetProfile();
const SPIKE = '18097aeb608f35d83a65b2cad987084c97c6e9d1dc02973f2a6f6cc2fcdd76e1';
const TX = {
  deploy: '62bd33fd5fe18ca2ddd78922f4685eabac97f4de2418492daf753568cee8b059',
  publish: '223050717f704fe47d1bd0b6b91da8ea248139d2d15a23a2eab7cf07d5a51418',
  remove: '646ad26baaa0390931438c626646af12ee939698d235464cd06f089f0a3f5aa2',
};

async function rec(name: string, run: (http: HttpClient) => Promise<unknown>): Promise<void> {
  const tape: Exchange[] = [];
  const http = new HttpClient({ minIntervalMs: profile.minIntervalMs, fetch: recordingFetch(tape) });
  const result = await run(http);
  saveTape(join(out, `${name}.tape.json`), tape);
  writeFileSync(join(out, `${name}.result.json`), `${toJson(result, 1)}\n`);
  process.stdout.write(`${name}: ${tape.length} exchanges\n`);
}

await rec('verify-spike-publish', (http) => verifyEmission({ profile, contract: SPIKE, tx: TX.publish, http }));
await rec('verify-spike-deploy', (http) => verifyEmission({ profile, contract: SPIKE, tx: TX.deploy, http }));
await rec('list-spike', (http) => listMetadata({ profile, contract: SPIKE, toBlock: 710820, http }));
const dir = mkdtempSync(join(tmpdir(), 'mip0018-scan-'));
try {
  await rec(
    'scan-710800-710820',
    async (http) => (await scan({ profile, stateDir: dir, fromHeight: 710800, toHeight: 710820, poll: true, http })).state,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
