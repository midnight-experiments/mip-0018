// SPDX-License-Identifier: Apache-2.0
//
// midnight-js 5.0.0-rc.2 providers for one compiled contract directory (compactc output: contract/, keys/, zkir/).
//
//   * proofs: the official proof server for contract circuits, through midnight-js's HTTP proving provider,
//     wrapped so at most 4 circuit proofs run at once (the server queues 10 jobs, then answers 429) and 408/429/502/504
//     and dropped connections are retried with backoff (midnight-js retries only 500/503 itself)
//   * public data: midnight-js's indexer provider (finalization tracking for deployContract / callTx)
//   * private state: the signer's 0600 file (maintenance keys + witness private state)
//   * wallet + submission: the wallet session, with the submission journal hooks

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { createProofProvider, type MidnightProviders, type ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { FinalizedTransaction } from '@midnightntwrk/ledger-v9';
import { WebSocket } from 'ws';
import type { FilePrivateStateProvider } from './private-state.ts';
import { midnightJsProviders, type SignerEndpoints, type WalletSession } from './wallet.ts';

const RETRYABLE = /\b(408|429|502|504)\b|ECONNRESET|socket hang up|fetch failed|other side closed|UND_ERR/u;

/** Runs at most `n` tasks at once. */
export function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export async function withRetry<T>(
  what: string,
  task: () => Promise<T>,
  attempts = 4,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await task();
    } catch (e) {
      last = e;
      if (i === attempts || !RETRYABLE.test(String((e as Error)?.message ?? e))) throw e;
      await sleep(Math.min(15_000, 1_000 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(`${what} failed`);
}

/** The bounded, retrying proof provider (contract circuits). */
export function boundedProofProvider(
  url: string,
  zkConfigProvider: NodeZkConfigProvider<string>,
  o: { concurrency?: number; timeoutMs?: number } = {},
): ProofProvider {
  const base = httpClientProvingProvider(url, zkConfigProvider, { timeout: o.timeoutMs ?? 600_000 });
  const limit = limiter(o.concurrency ?? 4);
  return createProofProvider({
    check: (preimage: Uint8Array, keyLocation: string) =>
      limit(() => withRetry('proof server /check', () => base.check(preimage, keyLocation))),
    prove: (preimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint) =>
      limit(() => withRetry('proof server /prove', () => base.prove(preimage, keyLocation, overwriteBindingInput))),
    lookupKey: (keyLocation: string) => base.lookupKey(keyLocation),
  } as never);
}

export interface CompiledArtifacts {
  /** Contract name (the compactc output's module and the provider tag). */
  name: string;
  /** compactc output directory (contract/, keys/, zkir/, compiler/). */
  managedDir: string;
}

/** Loads a compiled contract as a compact-js CompiledContract, with the adapter's witnesses or none. */
export const loadCompiledContract = async (a: CompiledArtifacts, witnesses?: Record<string, unknown>) => {
  const mod = (await import(pathToFileURL(join(a.managedDir, 'contract', 'index.js')).href)) as { Contract: new (...x: never[]) => never };
  const base = CompiledContract.make(a.name, mod.Contract as never) as unknown as { pipe: (...fs: unknown[]) => unknown };
  const assets = CompiledContract.withCompiledFileAssets(a.managedDir as never);
  // One pipe with both combinators (the intermediate value is not itself pipeable).
  return (
    witnesses
      ? base.pipe(CompiledContract.withWitnesses(witnesses as never), assets)
      : base.pipe(CompiledContract.withVacantWitnesses, assets)
  ) as never;
};

export interface SubmissionHooks {
  onBeforeSubmit?: (tx: FinalizedTransaction) => Promise<void>;
  onSubmitted?: (tx: FinalizedTransaction, txId: string) => Promise<void>;
}

export const buildProviders = (
  ep: SignerEndpoints,
  session: WalletSession,
  artifacts: CompiledArtifacts,
  privateStateProvider: FilePrivateStateProvider,
  hooks: SubmissionHooks = {},
): MidnightProviders => {
  setNetworkId(ep.profile.networkId);
  const zkConfigProvider = new NodeZkConfigProvider<string>(artifacts.managedDir);
  const { walletProvider, midnightProvider } = midnightJsProviders(session, hooks);
  return {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider({
      queryURL: ep.profile.indexer,
      subscriptionURL: ep.profile.indexerWs,
      webSocket: WebSocket as never,
    }),
    zkConfigProvider,
    proofProvider: boundedProofProvider(ep.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider,
  } as MidnightProviders;
};
