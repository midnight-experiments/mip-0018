// SPDX-License-Identifier: Apache-2.0
//
// Wallet SDK 2.0.0-beta.2 (facade 5.0.0-beta.2) wiring for midnight-js 5.0.0-rc.2.
//
// Why beta.2 and not the 2.0.0-rc.0 line: the rc wallets ask the indexer for
// `UnshieldedTransactionsProgress.protocolVersion`, which indexer 4.4.0-rc.1
// (the version Stagenet runs) does not serve, so they cannot sync.
//
// Never prints or stores seeds or keys; only public addresses and balances.

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
import { graphql } from './chain.js';
import type { NetworkConfig } from './network.js';

export type WalletSession = {
  readonly facade: WalletFacade;
  readonly keystore: UnshieldedKeystore;
  readonly shieldedSecretKeys: ZswapSecretKeys;
  readonly dustSecretKey: DustSecretKey;
  readonly networkId: string;
};

/** The network's current DUST parameters (never the built-in initial ones). */
const currentDustParameters = async (network: NetworkConfig) => {
  const { block } = await graphql<{ block: { ledgerParameters: string } }>(network, 'query { block { ledgerParameters } }');
  return LedgerParameters.deserialize(Buffer.from(block.ledgerParameters, 'hex')).dust;
};

/** Opens the wallet of a BIP-32 master seed: account 0, index 0, roles Zswap / NightExternal / Dust. */
export const openWallet = async (network: NetworkConfig, masterSeed: Uint8Array): Promise<WalletSession> => {
  const hd = HDWallet.fromSeed(masterSeed);
  masterSeed.fill(0);
  if (hd.type !== 'seedOk') throw new Error('the master seed cannot be used for HD derivation');
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  hd.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('key derivation failed');
  const shieldedSecretKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const keystore = createKeystore({ kind: 'schnorr', secret: derived.keys[Roles.NightExternal] }, network.networkId);
  for (const k of Object.values(derived.keys)) (k as Uint8Array).fill(0);

  const dustParameters = await currentDustParameters(network);
  const facade = await WalletFacade.init({
    configuration: {
      networkId: network.networkId,
      costParameters: { feeBlocksMargin: 5 },
      relayURL: new URL(network.nodeWs),
      provingServerUrl: new URL(network.walletProofServer),
      indexerClientConnection: { indexerHttpUrl: network.indexer, indexerWsUrl: network.indexerWs },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    },
    shielded: (c) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (c) => DustWallet(c).startWithSecretKey(dustSecretKey, dustParameters),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);
  return { facade, keystore, shieldedSecretKeys, dustSecretKey, networkId: network.networkId };
};

export const closeWallet = async (session: WalletSession) => {
  await session.facade.stop();
  session.shieldedSecretKeys.clear();
  session.dustSecretKey.clear();
};

/** Waits for a complete sync of all three wallets (bounded). */
export const waitForSync = async (session: WalletSession, timeoutMs = 20 * 60_000): Promise<FacadeState> =>
  Rx.firstValueFrom(
    session.facade.state().pipe(
      Rx.filter((s) => s.isSynced),
      Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`wallet sync timed out after ${timeoutMs} ms`)) }),
    ),
  );

/** Waits until the wallet holds spendable DUST (bounded). */
export const waitForDust = async (session: WalletSession, timeoutMs = 10 * 60_000): Promise<FacadeState> =>
  Rx.firstValueFrom(
    session.facade.state().pipe(
      Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
      Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`no DUST after ${timeoutMs} ms`)) }),
    ),
  );

export type PublicIdentity = {
  unshieldedAddress: string;
  shieldedAddress: string;
  dustAddress: string;
  night: string;
  dust: string;
  nightUtxos: number;
  nightUtxosRegisteredForDust: number;
};

export const describe = (session: WalletSession, state: FacadeState): PublicIdentity => {
  const night = nativeToken().raw;
  const nightCoins = state.unshielded.availableCoins.filter((c) => c.utxo.type === night);
  return {
    unshieldedAddress: session.keystore.getBech32Address().asString(),
    shieldedAddress: MidnightBech32m.encode(session.networkId, state.shielded.address).asString(),
    dustAddress: MidnightBech32m.encode(session.networkId, state.dust.address).asString(),
    night: (state.unshielded.balances[night] ?? 0n).toString(),
    dust: state.dust.balance(new Date()).toString(),
    nightUtxos: nightCoins.length,
    nightUtxosRegisteredForDust: nightCoins.filter((c) => c.meta.registeredForDustGeneration).length,
  };
};

/** midnight-js wallet + midnight providers backed by the facade (current era, ledger v9). */
export const midnightJsProviders = (session: WalletSession): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } => {
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
  const midnightProvider = createMidnightProvider((tx: FinalizedTransaction) => session.facade.submitTransaction(tx as never));
  return { walletProvider, midnightProvider };
};
