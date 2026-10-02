// SPDX-License-Identifier: Apache-2.0
//
// Local stack only: fund a test wallet from the dev chain's genesis wallet
// (public seed 0x00..01) and register its NIGHT for DUST generation.
// Called by docker/local-stack/fund.sh in the signer container:
//
//   MIP0018_SEED_FILE   hex seed of the test wallet (local, test-only; mode 0600)
//   MIP0018_FUND_NIGHT  whole NIGHT to send (default 1000)
//
// Prints the test wallet's public addresses and balances; never the seed.

import { nativeToken } from '@midnightntwrk/ledger-v9';
import * as Rx from 'rxjs';
import { local } from './lib/network.js';
import { seedFromHexFile } from './lib/secrets.js';
import { closeWallet, describe, openWallet, waitForSync } from './lib/wallet.js';

const GENESIS_DEV_SEED = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex');
const seedFile = process.env.MIP0018_SEED_FILE;
if (!seedFile) throw new Error('missing MIP0018_SEED_FILE');
const night = BigInt(process.env.MIP0018_FUND_NIGHT ?? '1000') * 1_000_000n; // STAR

const network = local();
const sender = await openWallet(network, GENESIS_DEV_SEED);
const receiver = await openWallet(network, seedFromHexFile(seedFile));
const log = (msg: string, v?: unknown) =>
  process.stderr.write(`${new Date().toISOString()} ${msg}${v === undefined ? '' : ` ${JSON.stringify(v)}`}\n`);
try {
  await waitForSync(sender);
  const before = describe(receiver, await waitForSync(receiver));
  log('test wallet before', before);

  if (BigInt(before.night) < night) {
    const recipe = await sender.facade.transferTransaction(
      [
        {
          type: 'unshielded',
          outputs: [{ amount: night, receiverAddress: await receiver.facade.unshielded.getAddress(), type: nativeToken().raw }],
        },
      ] as never,
      { shieldedSecretKeys: sender.shieldedSecretKeys, dustSecretKey: sender.dustSecretKey },
      { ttl: new Date(Date.now() + 30 * 60_000) },
    );
    const signed = await sender.facade.signRecipe(recipe, (p) => sender.keystore.signDataAsync(p));
    const txId = await sender.facade.submitTransaction(await sender.facade.finalizeRecipe(signed));
    log('NIGHT transfer submitted', { txId, night: night.toString() });
    await Rx.firstValueFrom(
      receiver.facade.state().pipe(
        Rx.filter((s) => s.isSynced && (s.unshielded.balances[nativeToken().raw] ?? 0n) >= night),
        Rx.timeout({ first: 300_000 }),
      ),
    );
  }

  const state = await waitForSync(receiver);
  const unregistered = state.unshielded.availableCoins.filter(
    (c) => c.utxo.type === nativeToken().raw && !c.meta.registeredForDustGeneration,
  );
  if (unregistered.length > 0) {
    const { fee } = await receiver.facade.estimateRegistration(unregistered);
    await receiver.facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: 600_000 });
    const recipe = await receiver.facade.registerNightUtxosForDustGeneration(unregistered, receiver.keystore.getPublicKey(), (p) =>
      receiver.keystore.signDataAsync(p),
    );
    // The facade already signed the registration; signing again makes the node reject it.
    const txId = await receiver.facade.submitTransaction(await receiver.facade.finalizeRecipe(recipe));
    log('DUST registration submitted', { txId, utxos: unregistered.length });
  }
  await Rx.firstValueFrom(
    receiver.facade.state().pipe(
      Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
      Rx.timeout({ first: 600_000 }),
    ),
  );
  const after = describe(receiver, await waitForSync(receiver));
  process.stdout.write(`${JSON.stringify(after)}\n`);
} finally {
  await closeWallet(receiver);
  await closeWallet(sender);
}
