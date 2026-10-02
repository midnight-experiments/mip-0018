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
import { normHex } from '../hex.ts';
import { Indexer } from '../indexer.ts';
import type { NetworkProfile } from '../network.ts';
import { existsSync } from 'node:fs';
import { decodeTyped, encodeTyped } from './private-state.ts';
import { readProtectedFile, seedFromHexFile, seedFromMnemonicFile, writeProtectedFile } from './secrets.ts';

export interface SignerEndpoints {
  profile: NetworkProfile;
  /** Proof server for contract circuits (reads ZKIR v3; official 9.0.0-rc.8 today, Q21). */
  proofServer: string;
  /** Proof server for the wallet's DUST spends (official 9.0.0-rc.6 today, Q21). */
  walletProofServer: string;
}

export interface WalletSession {
  readonly facade: WalletFacade;
  /** The network the wallet was opened on (the cache anchor is read from its indexer). */
  readonly profile: NetworkProfile;
  /** 0600 sync cache (serialized sub-wallet states) written on close, when the wallet was opened with one. */
  readonly cachePath?: string;
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

/** The hash (hex, no 0x) of the indexer's block at a height, or undefined when it has none. */
const blockHashAt = async (profile: NetworkProfile, height: number): Promise<string | undefined> => {
  const { block } = await new Indexer(profile.indexer, profile.indexerWs).query<{ block: { hash: string } | null }>(
    'query ($h: Int!) { block(offset: { height: $h }) { hash } }',
    { h: height },
  );
  return block ? normHex(block.hash) : undefined;
};

/** The network's current DUST parameters (never the built-in initial ones). */
const currentDustParameters = async (profile: NetworkProfile) => {
  const { block } = await new Indexer(profile.indexer, profile.indexerWs).query<{ block: { ledgerParameters: string } }>(
    'query { block { ledgerParameters } }',
  );
  return LedgerParameters.deserialize(Buffer.from(block.ledgerParameters, 'hex')).dust;
};

/** Opens the wallet of a BIP-32 master seed (the seed buffer is zeroed). */
type WalletCache = {
  kind: 'mip0018-wallet-cache';
  networkId: string;
  unshieldedAddress: string;
  /**
   * A block of the chain the cache was synced against (the indexer tip when it was written). A restore checks that the
   * chain still has that block: local chains restarted from the same genesis share network id and genesis but not
   * history, and restoring another chain's state makes the DUST sub-wallet fail forever ("values inserted
   * non-linearly into dust commitment tree").
   */
  anchor?: { height: number; hash: string };
  shielded: unknown;
  unshielded: unknown;
  dust: unknown;
};

/**
 * Opens the wallet of a BIP-32 master seed (the seed buffer is zeroed). With `cachePath` (a 0600 file in the signer's
 * private state directory) the three sub-wallets are restored from their serialized states and only sync the rest;
 * a cache of another wallet or network, or one that does not restore, is ignored (fresh sync). The cache holds
 * wallet secrets: it is written with mode 0600 and never printed.
 */
export const openWallet = async (
  ep: SignerEndpoints,
  seed: Uint8Array,
  o: { cachePath?: string; log?: (m: string) => void } = {},
): Promise<WalletSession> => {
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

  let cache: WalletCache | undefined;
  if (o.cachePath && existsSync(o.cachePath)) {
    try {
      const c = decodeTyped(JSON.parse(readProtectedFile(o.cachePath).toString('utf8'))) as WalletCache;
      if (
        c.kind === 'mip0018-wallet-cache' &&
        c.networkId === ep.profile.networkId &&
        c.unshieldedAddress === keystore.getBech32Address().asString()
      ) {
        const here = c.anchor ? await blockHashAt(ep.profile, c.anchor.height) : undefined;
        if (c.anchor && here === normHex(c.anchor.hash)) cache = c;
        else
          o.log?.(
            c.anchor
              ? `wallet cache was synced against another chain (block ${c.anchor.height} is ${here ?? 'missing'} here): ignored`
              : 'wallet cache has no chain anchor: ignored',
          );
      } else o.log?.('wallet cache belongs to another wallet or network: ignored');
    } catch (e) {
      o.log?.(`wallet cache unreadable (${(e as Error).message}): ignored`);
    }
  }
  const dustParameters = await currentDustParameters(ep.profile);
  const configuration = {
    networkId: ep.profile.networkId,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(ep.profile.rpcWs),
    provingServerUrl: new URL(ep.walletProofServer),
    indexerClientConnection: { indexerHttpUrl: ep.profile.indexer, indexerWsUrl: ep.profile.indexerWs },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  };
  const init = (c?: WalletCache) =>
    WalletFacade.init({
      configuration,
      shielded: (x) => (c ? ShieldedWallet(x).restore(c.shielded as never) : ShieldedWallet(x).startWithSecretKeys(shieldedSecretKeys)),
      unshielded: (x) =>
        c ? UnshieldedWallet(x).restore(c.unshielded as never) : UnshieldedWallet(x).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
      dust: (x) => (c ? DustWallet(x).restore(c.dust as never) : DustWallet(x).startWithSecretKey(dustSecretKey, dustParameters)),
    });
  let facade: WalletFacade;
  try {
    facade = await init(cache);
    if (cache) o.log?.('wallet restored from its 0600 sync cache');
  } catch (e) {
    if (!cache) throw e;
    o.log?.(`wallet cache did not restore (${(e as Error).message}): fresh sync`);
    facade = await init(undefined);
  }
  await facade.start(shieldedSecretKeys, dustSecretKey);
  return {
    facade,
    profile: ep.profile,
    keystore,
    shieldedSecretKeys,
    dustSecretKey,
    networkId: ep.profile.networkId,
    ...(o.cachePath ? { cachePath: o.cachePath } : {}),
  };
};

export const closeWallet = async (session: WalletSession): Promise<void> => {
  if (session.cachePath) {
    try {
      const f = session.facade as unknown as Record<'shielded' | 'unshielded' | 'dust', { serializeState(): Promise<unknown> }>;
      const tip = await new Indexer(session.profile.indexer, session.profile.indexerWs).latestBlock();
      const c: WalletCache = {
        kind: 'mip0018-wallet-cache',
        networkId: session.networkId,
        unshieldedAddress: session.keystore.getBech32Address().asString(),
        anchor: { height: tip.height, hash: normHex(tip.hash) },
        shielded: await f.shielded.serializeState(),
        unshielded: await f.unshielded.serializeState(),
        dust: await f.dust.serializeState(),
      };
      writeProtectedFile(session.cachePath, JSON.stringify(encodeTyped(c)));
    } catch {
      /* a cache is an optimisation; never fail a command because of it */
    }
  }
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
  /** Unshielded balances per token type (hex) — NIGHT and every native unshielded token (kind 2 colors). */
  unshieldedBalances: Record<string, string>;
  /** Shielded balances per token type (hex) — every native shielded token the wallet holds (kind 1 colors). */
  shieldedBalances: Record<string, string>;
}

const balanceMap = (b: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((b ?? {}) as Record<string, bigint>)
      .map(([k, v]) => [String(k).toLowerCase().replace(/^0x/u, ''), String(v)] as [string, string])
      .sort(([a], [c]) => (a < c ? -1 : 1)),
  );

/**
 * Bech32m of a wallet SDK address object through ITS OWN class codec. `MidnightBech32m.encode` looks the codec up by a
 * module-local Symbol, which fails when npm installs more than one copy of wallet-sdk-address-format.
 */
const bech32 = (networkId: string, item: unknown): string =>
  (item as { constructor: { codec: { encode(n: string, i: unknown): { asString(): string } } } }).constructor.codec
    .encode(networkId, item)
    .asString();

export const describeWallet = (session: WalletSession, state: FacadeState): PublicIdentity => {
  const night = nativeToken().raw;
  const nightCoins = state.unshielded.availableCoins.filter((c) => c.utxo.type === night);
  return {
    unshieldedAddress: session.keystore.getBech32Address().asString(),
    coinPublicKey: String(session.shieldedSecretKeys.coinPublicKey),
    shieldedAddress: bech32(session.networkId, state.shielded.address),
    dustAddress: bech32(session.networkId, state.dust.address),
    night: (state.unshielded.balances[night] ?? 0n).toString(),
    dust: state.dust.balance(new Date()).toString(),
    nightUtxos: nightCoins.length,
    nightUtxosRegisteredForDust: nightCoins.filter((c) => c.meta.registeredForDustGeneration).length,
    unshieldedBalances: balanceMap(state.unshielded.balances),
    shieldedBalances: balanceMap((state.shielded as unknown as { balances?: unknown }).balances),
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
