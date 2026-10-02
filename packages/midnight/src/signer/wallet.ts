// SPDX-License-Identifier: Apache-2.0
//
// Wallet session: wallet SDK 2.0.0-beta.2 (facade 5.0.0-beta.2) behind midnight-js 5.0.0-rc.2 providers (Q22).
//
//   * opened from a protected secret FILE (BIP-39 mnemonic → 64-byte seed, or — local test wallets only — a hex
//     seed); HD account 0, index 0, roles Zswap / NightExternal / Dust (Lace-compatible); seeds are zeroed after use
//   * complete sync = all three sub-wallets strictly complete AND connected on 3 consecutive samples ≥ 1 s apart
//     (the facade's `isSynced` alone can flip back while the indexer still streams)
//   * DUST registration: estimate, wait until the unregistered UTxOs generated enough DUST for the fee, register;
//     the facade already signs the registration, so it is NOT signed again (a second signature makes the node
//     reject it)
//   * `feeBlocksMargin` 5 (the margin is consumed, not reserved: 100 blocks ≈ 89× the fee on Stagenet)
//
// Never prints or stores a seed or key; only public addresses and balances.

import {
  DustWallet,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  MidnightBech32m,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  createKeystore,
  mergeWalletEntries,
  type FacadeState,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk';
import { DustSecretKey, LedgerParameters, ZswapSecretKeys, nativeToken, type FinalizedTransaction } from '@midnightntwrk/ledger-v9';
import { createMidnightProvider, createWalletProvider } from '@midnight-ntwrk/midnight-js-types';
import type { MidnightProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import * as Rx from 'rxjs';
import { Indexer } from '../indexer.ts';
import type { NetworkProfile } from '../network.ts';
import { seedFromHexFile, seedFromMnemonicFile } from './secrets.ts';

export interface SignerEndpoints {
  profile: NetworkProfile;
  /** Proof server for contract circuits (reads ZKIR v3; official 9.0.0-rc.8 today, Q21). */
  proofServer: string;
  /** Proof server for the wallet's DUST spends (official 9.0.0-rc.6 today, Q21). */
  walletProofServer: string;
}

export interface WalletSession {
  readonly facade: WalletFacade;
  readonly keystore: UnshieldedKeystore;
  readonly shieldedSecretKeys: ZswapSecretKeys;
  readonly dustSecretKey: DustSecretKey;
  readonly networkId: string;
}

export interface WalletSecret {
  mnemonicFile?: string;
  /** Hex seed file — local undeployed chains only (test wallets from docker/local-stack/fund.sh). */
  seedFile?: string;
  /** The dev chain's public genesis wallet (seed 0x00…01) — local undeployed chains only. */
  devGenesis?: boolean;
}

export const GENESIS_DEV_SEED_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

export class WalletError extends Error {
  override name = 'WalletError';
}

/** Reads the master seed from the secret named by `s` (never logs it). */
export function masterSeed(s: WalletSecret, profile: NetworkProfile): Uint8Array {
  const given = [s.mnemonicFile, s.seedFile, s.devGenesis ? 'dev' : undefined].filter((x) => x !== undefined);
  if (given.length !== 1) throw new WalletError('give exactly one of --mnemonic-file, --seed-file or --dev-genesis-wallet');
  if (s.mnemonicFile) return seedFromMnemonicFile(s.mnemonicFile);
  if (profile.id !== 'undeployed') throw new WalletError('--seed-file and --dev-genesis-wallet are for local undeployed chains only');
  if (s.seedFile) return seedFromHexFile(s.seedFile);
  return Uint8Array.from(Buffer.from(GENESIS_DEV_SEED_HEX, 'hex'));
}

/** The network's current DUST parameters (never the built-in initial ones). */
const currentDustParameters = async (profile: NetworkProfile) => {
  const { block } = await new Indexer(profile.indexer, profile.indexerWs).query<{ block: { ledgerParameters: string } }>(
    'query { block { ledgerParameters } }',
  );
  return LedgerParameters.deserialize(Buffer.from(block.ledgerParameters, 'hex')).dust;
};

/** Opens the wallet of a BIP-32 master seed (the seed buffer is zeroed). */
export const openWallet = async (ep: SignerEndpoints, seed: Uint8Array): Promise<WalletSession> => {
  const hd = HDWallet.fromSeed(seed);
  seed.fill(0);
  if (hd.type !== 'seedOk') throw new WalletError('the master seed cannot be used for HD derivation');
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  hd.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new WalletError('key derivation failed');
  const shieldedSecretKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const keystore = createKeystore({ kind: 'schnorr', secret: derived.keys[Roles.NightExternal] }, ep.profile.networkId);
  for (const k of Object.values(derived.keys)) (k as Uint8Array).fill(0);

  const dustParameters = await currentDustParameters(ep.profile);
  const facade = await WalletFacade.init({
    configuration: {
      networkId: ep.profile.networkId,
      costParameters: { feeBlocksMargin: 5 },
      relayURL: new URL(ep.profile.rpcWs),
      provingServerUrl: new URL(ep.walletProofServer),
      indexerClientConnection: { indexerHttpUrl: ep.profile.indexer, indexerWsUrl: ep.profile.indexerWs },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    },
    shielded: (c) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (c) => DustWallet(c).startWithSecretKey(dustSecretKey, dustParameters),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);
  return { facade, keystore, shieldedSecretKeys, dustSecretKey, networkId: ep.profile.networkId };
};

export const closeWallet = async (session: WalletSession): Promise<void> => {
  await session.facade.stop();
  session.shieldedSecretKeys.clear();
  session.dustSecretKey.clear();
};

const strictlyComplete = (s: FacadeState): boolean => {
  const parts = [s.shielded.state.progress, s.dust.state.progress, s.unshielded.progress] as {
    isConnected: boolean;
    isStrictlyComplete(): boolean;
  }[];
  return parts.every((p) => p.isConnected && p.isStrictlyComplete());
};

/** Complete sync: 3 consecutive samples ≥ 1 s apart in which all three sub-wallets are strictly complete (bounded). */
export const waitForSync = async (session: WalletSession, timeoutMs = 20 * 60_000, samples = 3): Promise<FacadeState> => {
  let latest: FacadeState | undefined;
  const sub = session.facade.state().subscribe((s) => (latest = s));
  try {
    const until = Date.now() + timeoutMs;
    let good = 0;
    for (;;) {
      if (latest && strictlyComplete(latest)) good++;
      else good = 0;
      if (good >= samples && latest) return latest;
      if (Date.now() > until) throw new WalletError(`wallet sync not complete after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  } finally {
    sub.unsubscribe();
  }
};

/** Waits until the wallet holds spendable DUST (bounded). */
export const waitForDust = async (session: WalletSession, timeoutMs = 10 * 60_000): Promise<FacadeState> =>
  Rx.firstValueFrom(
    session.facade.state().pipe(
      Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
      Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new WalletError(`no DUST after ${timeoutMs} ms`)) }),
    ),
  );

export interface PublicIdentity {
  unshieldedAddress: string;
  /** Shielded coin public key (hex) — public; the recipient of shielded mints. */
  coinPublicKey: string;
  shieldedAddress: string;
  dustAddress: string;
  /** STAR (1 NIGHT = 10^6 STAR). */
  night: string;
  /** SPECK (1 DUST = 10^15 SPECK). */
  dust: string;
  nightUtxos: number;
  nightUtxosRegisteredForDust: number;
}

export const describeWallet = (session: WalletSession, state: FacadeState): PublicIdentity => {
  const night = nativeToken().raw;
  const nightCoins = state.unshielded.availableCoins.filter((c) => c.utxo.type === night);
  return {
    unshieldedAddress: session.keystore.getBech32Address().asString(),
    coinPublicKey: String(session.shieldedSecretKeys.coinPublicKey),
    shieldedAddress: MidnightBech32m.encode(session.networkId, state.shielded.address).asString(),
    dustAddress: MidnightBech32m.encode(session.networkId, state.dust.address).asString(),
    night: (state.unshielded.balances[night] ?? 0n).toString(),
    dust: state.dust.balance(new Date()).toString(),
    nightUtxos: nightCoins.length,
    nightUtxosRegisteredForDust: nightCoins.filter((c) => c.meta.registeredForDustGeneration).length,
  };
};

export interface RegistrationResult {
  before: PublicIdentity;
  /** UTxOs that were not registered. */
  unregistered: number;
  /** Fee estimate (SPECK) for registering them. */
  feeEstimate?: string;
  /** 'skipped' when every NIGHT UTxO was already registered (before-check). */
  outcome: 'skipped' | 'estimated' | 'registered';
  txId?: string;
  after?: PublicIdentity;
}

/**
 * Registers every unregistered NIGHT UTxO for DUST generation. Before-check: nothing to do → skipped. After-check:
 * the UTxOs show `registeredForDustGeneration` and DUST > 0 before it returns.
 */
export const registerDust = async (
  session: WalletSession,
  o: { estimateOnly?: boolean; timeoutMs?: number } = {},
): Promise<RegistrationResult> => {
  const state = await waitForSync(session);
  const before = describeWallet(session, state);
  const unregistered = state.unshielded.availableCoins.filter(
    (c) => c.utxo.type === nativeToken().raw && !c.meta.registeredForDustGeneration,
  );
  if (unregistered.length === 0) return { before, unregistered: 0, outcome: 'skipped' };
  const { fee } = await session.facade.estimateRegistration(unregistered);
  if (o.estimateOnly) return { before, unregistered: unregistered.length, feeEstimate: fee.toString(), outcome: 'estimated' };
  await session.facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: o.timeoutMs ?? 600_000 });
  const recipe = await session.facade.registerNightUtxosForDustGeneration(unregistered, session.keystore.getPublicKey(), (p) =>
    session.keystore.signDataAsync(p),
  );
  const txId = String(await session.facade.submitTransaction(await session.facade.finalizeRecipe(recipe)));
  const wanted = new Set(unregistered.map((c) => `${c.utxo.intentHash}:${c.utxo.outputNo}`));
  const done = await Rx.firstValueFrom(
    session.facade.state().pipe(
      Rx.filter(
        (s) =>
          s.isSynced &&
          s.dust.balance(new Date()) > 0n &&
          s.unshielded.availableCoins
            .filter((c) => wanted.has(`${c.utxo.intentHash}:${c.utxo.outputNo}`))
            .every((c) => c.meta.registeredForDustGeneration),
      ),
      Rx.timeout({
        first: o.timeoutMs ?? 600_000,
        with: () => Rx.throwError(() => new WalletError('registration not observed in time; re-run `wallet status`')),
      }),
    ),
  );
  return {
    before,
    unregistered: unregistered.length,
    feeEstimate: fee.toString(),
    outcome: 'registered',
    txId,
    after: describeWallet(session, done),
  };
};

/**
 * midnight-js wallet + midnight providers backed by the facade (current era, ledger v9). `onBeforeSubmit` runs with
 * the finalized transaction BEFORE the node sees it (the submission journal hooks in here).
 */
export const midnightJsProviders = (
  session: WalletSession,
  hooks: {
    onBeforeSubmit?: (tx: FinalizedTransaction) => Promise<void>;
    onSubmitted?: (tx: FinalizedTransaction, txId: string) => Promise<void>;
  } = {},
): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } => {
  const walletProvider = createWalletProvider({
    getCoinPublicKey: () => session.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => session.shieldedSecretKeys.encryptionPublicKey,
    balanceTx: async (tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> => {
      const recipe = await session.facade.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: session.shieldedSecretKeys, dustSecretKey: session.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60_000) },
      );
      const signed = await session.facade.signRecipe(recipe, (payload) => session.keystore.signDataAsync(payload));
      return (await session.facade.finalizeRecipe(signed)) as unknown as FinalizedTransaction;
    },
  });
  const midnightProvider = createMidnightProvider(async (tx: FinalizedTransaction) => {
    await hooks.onBeforeSubmit?.(tx);
    const txId = await session.facade.submitTransaction(tx as never);
    await hooks.onSubmitted?.(tx, String(txId));
    return txId;
  });
  return { walletProvider, midnightProvider };
};
