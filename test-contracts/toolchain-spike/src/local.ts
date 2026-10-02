// SPDX-License-Identifier: Apache-2.0
//
// S0 spike, step 2: the local undeployed chain (docker/local-stack).
// Signs with the dev chain's genesis wallet, whose seed is public (0x00..01);
// no secret is involved. Run on the stack's network:
//
//   docker/local-stack/up.sh
//   . docker/local-stack/ports.env
//   MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK docker/run.sh spike:local
//   docker/local-stack/down.sh

import { join } from 'node:path';
import { local } from './lib/network.js';
import { CONTRACT, runSpike } from './lib/spike.js';
import { toolchain } from './lib/versions.js';
import { closeWallet, openWallet } from './lib/wallet.js';

const GENESIS_DEV_SEED = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex');

const network = local();
const repo = join(import.meta.dirname, '..', '..', '..');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const recordPath = process.env.SPIKE_RECORD ?? join(repo, 'docker', 'local-stack', '.state', `spike-local-${stamp}.json`);

const session = await openWallet(network, GENESIS_DEV_SEED);
try {
  const record = await runSpike({ network, session, recordPath, secondCall: true, tryMidnightJsRemove: true, toolchain: toolchain(CONTRACT) });
  process.stdout.write(`${JSON.stringify({ result: record.result, record: recordPath, contract: record.contract })}\n`);
} catch (e) {
  process.stderr.write(`spike failed: ${(e as Error).stack ?? String(e)}\nrecord: ${recordPath}\n`);
  process.exitCode = 1;
} finally {
  await closeWallet(session);
}
