// SPDX-License-Identifier: Apache-2.0
//
// S0 spike, step 3: Stagenet. Runs ONLY in the signer container
// (docker/signer.sh), which mounts the wallet mnemonic file read-only and a
// private state directory (both outside the repository).
//
//   MIP0018_MNEMONIC_FILE      path of the BIP-39 mnemonic file (mode 0600)
//   MIP0018_STATE_DIR          private directory for the maintenance signing key
//   MIP0018_PROOF_SERVER_URL   local official proof server (no public one exists)
//   MIP0018_EXPECTED_ADDRESS   the signer's unshielded address (refuses any other wallet)
//
// Writes the public record to test-contracts/toolchain-spike/records/stagenet.json.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stagenet } from './lib/network.js';
import { seedFromMnemonicFile } from './lib/secrets.js';
import { CONTRACT, runSpike } from './lib/spike.js';
import { toolchain } from './lib/versions.js';
import { closeWallet, openWallet } from './lib/wallet.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
};

const network = stagenet();
const recordPath = process.env.SPIKE_RECORD ?? join(import.meta.dirname, '..', 'records', 'stagenet.json');
if (existsSync(recordPath) && !process.env.SPIKE_ALLOW_NEW_RUN) {
  throw new Error(`${recordPath} exists: a Stagenet spike was already run; reconcile it instead of running again`);
}
const privateStatePath = join(need('MIP0018_STATE_DIR'), 's0-spike-private-state.json');

const session = await openWallet(network, seedFromMnemonicFile(need('MIP0018_MNEMONIC_FILE')));
try {
  const record = await runSpike({
    network,
    session,
    recordPath,
    privateStatePath,
    secondCall: false,
    tryMidnightJsRemove: false,
    expectedUnshieldedAddress: need('MIP0018_EXPECTED_ADDRESS'),
    toolchain: toolchain(CONTRACT),
  });
  process.stdout.write(`${JSON.stringify({ result: record.result, record: recordPath, contract: record.contract })}\n`);
} catch (e) {
  process.stderr.write(`spike failed: ${(e as Error).stack ?? String(e)}\nrecord: ${recordPath}\n`);
  process.exitCode = 1;
} finally {
  await closeWallet(session);
}
