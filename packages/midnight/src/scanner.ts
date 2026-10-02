// SPDX-License-Identifier: Apache-2.0
//
// The reference mint scanner (owner decision F8; spec FR-043; MIP-0018 "Lookup").
//
// Today's public indexer exposes no mint effects, so the color table is built from the chain itself: from a start
// height, every block's transactions are read (indexer `blocks` subscription, polling `block(offset:{height})` as the
// fallback), each contract call's raw transaction is decoded with ledger-v9, and for the parts that took effect
// (guaranteed unless the transaction FAILED; fallible only in a successful segment) every `shieldedMints` /
// `unshieldedMints` effect (domainSep → amount) gives a row
//
//     color = tokenType(domainSep, contractAddress)  →  { contractAddress, domainSep, shielded?, unshielded? }
//
// with the first mint (height, transaction) per kind. The same pass keeps every MIP-0018 event (exact v1 name) per
// contract with its chain position and classification, so `lookup` can show metadata for the scanned range without
// another query.
//
// State: ONE JSON file (`<state dir>/index-state.json`) rewritten atomically (temp file, fsync, rename) after every
// block, so a killed scan resumes at `nextHeight` with an identical table. Heights must be consecutive and each
// block's parent must be the previous block (the indexer serves finalized blocks only, so a mismatch is an error).
// One scanner per state directory.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_NAME_TEXT } from '@mip0018/codec';
import { tokenTypeHex } from './color.ts';
import { normHex } from './hex.ts';
import { HttpClient, realSleep } from './http.ts';
import { Indexer, type ScannedBlock } from './indexer.ts';
import { checkIdentity, type NetworkProfile } from './network.ts';
import { applied, decodeTransaction } from './raw.ts';
import { classify } from './verify.ts';

export const STATE_FILE = 'index-state.json';
const MIP0018_NAME_HEX = Buffer.from(EVENT_NAME_TEXT, 'utf8').toString('hex').padEnd(64, '0');

export interface MintRef {
  height: number;
  blockHash: string;
  txHash: string;
}

export interface MintStats {
  firstMint: MintRef;
  lastMint: MintRef;
  mints: number;
  /** Sum of minted amounts (decimal string). */
  amount: string;
}

export interface ColorEntry {
  color: string;
  contractAddress: string;
  domainSep: string;
  /** Present when a shielded mint (kind 1) of this color was seen. */
  shielded?: MintStats;
  /** Present when an unshielded mint (kind 2) of this color was seen. */
  unshielded?: MintStats;
}

export interface IndexedEvent {
  block: { height: number; hash: string };
  txHash: string;
  /** Position of the transaction in its block. */
  txIndex: number;
  /** Position among the applied logs of the transaction (ledger order). */
  eventIndex: number;
  phase: 'guaranteed' | 'fallible';
  segment: number;
  entryPoint: string;
  name: string;
  payload: string;
  result: 'accept' | 'reject' | 'ignore';
  reason?: string;
  domainSep?: string;
  kind?: number;
}

export interface ScanState {
  kind: 'mip0018-index-state';
  schema: 1;
  network: { id: string; networkId: string; genesisHash: string };
  fromHeight: number;
  /** The next height to scan (everything below it, from `fromHeight`, is in the table). */
  nextHeight: number;
  lastBlock: { height: number; hash: string } | null;
  colors: Record<string, ColorEntry>;
  /** MIP-0018 events (exact v1 name) per contract address, in chain order. */
  events: Record<string, IndexedEvent[]>;
  /** Contract deployments seen in the range (address → where). */
  deploys: Record<string, MintRef>;
  stats: { blocks: number; transactions: number; contractCalls: number; deploys: number; decodeErrors: number; mints: number; events: number };
  errors: { height: number; txHash: string; message: string }[];
  updatedAt: string;
}

export class ScanError extends Error {
  override name = 'ScanError';
}

export function statePath(dir: string): string {
  return join(dir, STATE_FILE);
}

export function loadState(dir: string): ScanState | undefined {
  const p = statePath(dir);
  if (!existsSync(p)) return undefined;
  const s = JSON.parse(readFileSync(p, 'utf8')) as ScanState;
  if (s.kind !== 'mip0018-index-state' || s.schema !== 1) throw new ScanError(`${p} is not a version-1 index state`);
  return s;
}

/** Atomic write: temp file in the same directory, fsync, rename. */
export function saveState(dir: string, s: ScanState): void {
  mkdirSync(dir, { recursive: true });
  s.updatedAt = new Date().toISOString();
  const p = statePath(dir);
  const tmp = `${p}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(s, null, 1)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

export function newState(profile: NetworkProfile, genesisHash: string, fromHeight: number): ScanState {
  return {
    kind: 'mip0018-index-state',
    schema: 1,
    network: { id: profile.id, networkId: profile.networkId, genesisHash },
    fromHeight,
    nextHeight: fromHeight,
    lastBlock: null,
    colors: {},
    events: {},
    deploys: {},
    stats: { blocks: 0, transactions: 0, contractCalls: 0, deploys: 0, decodeErrors: 0, mints: 0, events: 0 },
    errors: [],
    updatedAt: new Date().toISOString(),
  };
}

function addMint(stats: MintStats | undefined, ref: MintRef, amount: bigint): MintStats {
  if (!stats) return { firstMint: ref, lastMint: ref, mints: 1, amount: amount.toString() };
  return { ...stats, lastMint: ref, mints: stats.mints + 1, amount: (BigInt(stats.amount) + amount).toString() };
}

/** Applies one block to the state (pure apart from mutating `s`). */
export function applyBlock(s: ScanState, b: ScannedBlock): { mints: number; events: number } {
  if (b.height !== s.nextHeight) throw new ScanError(`expected block ${s.nextHeight}, got ${b.height}`);
  if (s.lastBlock && s.lastBlock.height === b.height - 1 && b.parent && normHex(b.parent.hash) !== s.lastBlock.hash) {
    throw new ScanError(`block ${b.height}: parent ${b.parent.hash} is not the scanned block ${s.lastBlock.height} (${s.lastBlock.hash})`);
  }
  let mints = 0;
  let events = 0;
  b.transactions.forEach((tx, txIndex) => {
    s.stats.transactions++;
    for (const a of tx.contractActions) {
      if (a.__typename !== 'ContractDeploy') continue;
      s.deploys[normHex(a.address)] = { height: b.height, blockHash: normHex(b.hash), txHash: normHex(tx.hash) };
      s.stats.deploys++;
    }
    if (!tx.contractActions.some((a) => a.__typename === 'ContractCall')) return;
    s.stats.contractCalls++;
    let d;
    try {
      d = decodeTransaction(tx.raw);
      if (d.hash !== normHex(tx.hash)) throw new Error(`recomputed hash ${d.hash} differs from the indexer's ${tx.hash}`);
    } catch (e) {
      s.stats.decodeErrors++;
      s.errors.push({ height: b.height, txHash: tx.hash, message: (e as Error).message });
      return;
    }
    const ok = applied(d, tx.transactionResult);
    const ref: MintRef = { height: b.height, blockHash: normHex(b.hash), txHash: normHex(tx.hash) };
    for (const m of ok.mints) {
      const color = tokenTypeHex(m.domainSep, m.contractAddress);
      const e: ColorEntry = s.colors[color] ?? { color, contractAddress: m.contractAddress, domainSep: m.domainSep };
      if (e.contractAddress !== m.contractAddress || e.domainSep !== m.domainSep) {
        throw new ScanError(`color ${color} maps to two (contract, domainSep) pairs — impossible unless tokenType is broken`);
      }
      if (m.kind === 'shielded') e.shielded = addMint(e.shielded, ref, m.amount);
      else e.unshielded = addMint(e.unshielded, ref, m.amount);
      s.colors[color] = e;
      s.stats.mints++;
      mints++;
    }
    ok.logs.forEach((l, eventIndex) => {
      if (l.name !== MIP0018_NAME_HEX || l.payload === undefined) return;
      const c = classify(l.name, l.payload);
      const ev: IndexedEvent = {
        block: { height: b.height, hash: normHex(b.hash) },
        txHash: normHex(tx.hash),
        txIndex,
        eventIndex,
        phase: l.phase,
        segment: l.segment,
        entryPoint: l.entryPoint,
        name: l.name,
        payload: l.payload,
        result: c.result,
      };
      if (c.reason !== undefined) ev.reason = c.reason;
      if (c.domainSep !== undefined) ev.domainSep = c.domainSep;
      if (c.kind !== undefined) ev.kind = c.kind;
      (s.events[l.contractAddress] ??= []).push(ev);
      s.stats.events++;
      events++;
    });
  });
  s.stats.blocks++;
  s.lastBlock = { height: b.height, hash: normHex(b.hash) };
  s.nextHeight = b.height + 1;
  return { mints, events };
}

export interface ScanOptions {
  profile: NetworkProfile;
  stateDir: string;
  fromHeight: number;
  /** Inclusive end height; default: the indexer tip when the scan starts (ignored with `follow`). */
  toHeight?: number;
  /** Keep following new blocks until aborted. */
  follow?: boolean;
  /** Force polling (no WebSocket subscription). */
  poll?: boolean;
  signal?: AbortSignal;
  http?: HttpClient;
  /** Called after every checkpoint. */
  onBlock?: (s: ScanState, b: ScannedBlock, delta: { mints: number; events: number }) => void;
  log?: (msg: string) => void;
  /** Test hook: stop the process (SIGKILL) after this many blocks were checkpointed in this run. */
  crashAfterBlocks?: number;
}

export interface ScanResult {
  state: ScanState;
  mode: 'subscription' | 'polling' | 'none';
  blocksThisRun: number;
  requests: number;
  seconds: number;
}

export async function scan(o: ScanOptions): Promise<ScanResult> {
  const log = o.log ?? (() => {});
  const http = o.http ?? new HttpClient({ minIntervalMs: o.profile.minIntervalMs });
  const indexer = new Indexer(o.profile.indexer, o.profile.indexerWs, http);
  const genesis = await checkIdentity(o.profile, http);
  let s = loadState(o.stateDir);
  if (s) {
    if (s.network.genesisHash !== genesis || s.network.id !== o.profile.id) {
      throw new ScanError(`${statePath(o.stateDir)} belongs to ${s.network.id} ${s.network.genesisHash}, not ${o.profile.id} ${genesis}`);
    }
    if (s.fromHeight !== o.fromHeight) {
      throw new ScanError(
        `${statePath(o.stateDir)} started at height ${s.fromHeight}; resume with --from-height ${s.fromHeight} or use a new --state directory`,
      );
    }
    log(`resuming at height ${s.nextHeight} (${Object.keys(s.colors).length} colors, ${s.stats.events} events so far)`);
  } else {
    s = newState(o.profile, genesis, o.fromHeight);
    saveState(o.stateDir, s);
  }
  const state = s;
  const started = Date.now();
  const tip = await indexer.latestBlock();
  const end = o.follow ? Number.POSITIVE_INFINITY : Math.min(o.toHeight ?? tip.height, tip.height);
  if (!o.follow && o.toHeight !== undefined && o.toHeight > tip.height)
    log(`--to-height ${o.toHeight} is above the indexer tip ${tip.height}; stopping at the tip`);
  let blocksThisRun = 0;
  const take = (b: ScannedBlock) => {
    const delta = applyBlock(state, b);
    saveState(o.stateDir, state);
    blocksThisRun++;
    o.onBlock?.(state, b, delta);
    if (o.crashAfterBlocks !== undefined && blocksThisRun >= o.crashAfterBlocks) {
      log(`test hook: killing the scanner after ${blocksThisRun} block(s)`);
      process.kill(process.pid, 'SIGKILL');
    }
  };
  if (state.nextHeight > end) return { state, mode: 'none', blocksThisRun, requests: http.requests, seconds: 0 };

  let mode: ScanResult['mode'] = o.poll ? 'polling' : 'subscription';
  if (!o.poll) {
    try {
      for await (const m of indexer.subscribeBlocks(state.nextHeight, { signal: o.signal, idleTimeoutMs: o.follow ? 0 : 60_000 })) {
        const b = m.blocks;
        if (b.height < state.nextHeight) continue; // duplicate after a reconnect
        if (b.height > state.nextHeight) throw new ScanError(`subscription skipped from ${state.nextHeight} to ${b.height}`);
        take(b);
        if (state.nextHeight > end) break;
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
      log(`subscription failed at height ${state.nextHeight} (${(e as Error).message}); falling back to polling`);
      mode = 'polling';
    }
  }
  if (mode === 'polling') {
    while (state.nextHeight <= end) {
      if (o.signal?.aborted) break;
      const b = await indexer.scanBlock(state.nextHeight);
      if (b === null) {
        if (!o.follow) throw new ScanError(`the indexer has no block ${state.nextHeight} (tip was ${tip.height})`);
        await realSleep(6_000);
        continue;
      }
      take(b);
    }
  }
  return { state, mode, blocksThisRun, requests: http.requests, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

export interface LookupResult {
  found: boolean;
  color: string;
  scanned: { network: string; genesisHash: string; from: number; to: number };
  entry?: ColorEntry;
  /** Token identities this color resolves to (kind 1 for a shielded coin, kind 2 for an unshielded UTXO). */
  identities: { contractAddress: string; domainSep: string; kind: 1 | 2; mintedInRange: boolean }[];
}

/** Resolves a color through the table. `kind` narrows to what the user holds (1 shielded coin, 2 unshielded UTXO). */
export function lookupColor(s: ScanState, color: string, kind?: 1 | 2): LookupResult {
  const c = normHex(color);
  const entry = s.colors[c];
  const scanned = { network: s.network.id, genesisHash: s.network.genesisHash, from: s.fromHeight, to: s.nextHeight - 1 };
  if (!entry) return { found: false, color: c, scanned, identities: [] };
  const kinds: (1 | 2)[] = kind
    ? [kind]
    : ([entry.shielded ? 1 : undefined, entry.unshielded ? 2 : undefined].filter(Boolean) as (1 | 2)[]);
  return {
    found: true,
    color: c,
    scanned,
    entry,
    identities: kinds.map((k) => ({
      contractAddress: entry.contractAddress,
      domainSep: entry.domainSep,
      kind: k,
      mintedInRange: k === 1 ? !!entry.shielded : !!entry.unshielded,
    })),
  };
}
