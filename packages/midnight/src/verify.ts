// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free verification of one MIP-0018 emission: network + contract + transaction.
//
//  1. identity       node genesis = the profile's (Stagenet pinned)
//  2. indexer        the contract's Misc events in that transaction + the transaction (raw bytes, result, block)
//  3. raw tx         ledger-v9: recomputed hash and identifiers equal the indexer's; every indexed event equals a
//                    `log` op of the contract in the raw transaction (same segment, same zero-extended name ‖ payload,
//                    same order) and every applied Misc log of the contract is indexed (nothing missing)
//  4. event record   the contract address comes from the event record (indexer field and the decoded raw event,
//                    `contractLog.address`), never from the payload
//  5. classify       MIP-0018 name check → ignore; decode → accept | reject (whole event) with the reason
//  6. node           `chain_getBlockHash(height)` = the indexer's block hash; height ≤ finalized height; the raw
//                    transaction bytes are inside one of the block's extrinsics
//  7. expectation    optional, per event (payload bytes, decoded header/records, or result/reason)
//
// Outcomes / exit codes: ok 0 · mismatch 1 · (usage 2, CLI) · not-found 3 · not-indexed 4 (indexer behind the node,
// the transaction is in a block that is not final yet, or the block is not finalized on the node).

import {
  classifyEvent,
  encodePayload,
  commonRecords,
  record as rec,
  EVENT_NAME,
  type Classification,
  type MetadataRecord,
} from '@mip0018/codec';
import { bytesToHex, hexToBytes, normAddress, normHex, normTxHash, zeroExtendHex } from './hex.ts';
import { HttpClient } from './http.ts';
import { Indexer, type IndexedMiscEvent, type IndexedTransaction, type BlockInfo } from './indexer.ts';
import { checkIdentity, type NetworkProfile } from './network.ts';
import { decodeEventRaw, decodeTransaction, miscLogsOf, partApplied, transactionHashInExtrinsic, type DecodedTransaction } from './raw.ts';
import { NodeRpc } from './rpc.ts';

export type Outcome = 'ok' | 'mismatch' | 'not-found' | 'not-indexed';
export const EXIT: Record<Outcome, number> = { ok: 0, mismatch: 1, 'not-found': 3, 'not-indexed': 4 };

export interface Check {
  id: string;
  ok: boolean;
  message: string;
}

/** What the caller expects of one event. Every given field must match. */
export interface EventExpectation {
  result?: 'accept' | 'reject' | 'ignore';
  reason?: string;
  /** Exact 256-byte payload (hex). */
  payload?: string;
  /** Exact 32-byte name (hex). */
  name?: string;
  domainSep?: string;
  kind?: number;
  /** Exact record list, in order. `value` is text for valType 1/3/4, a decimal or number for 2, hex for 0, "" for 5. */
  records?: { key: string; valType: number; value: string | number }[];
  /** Shorthand: the payload `encodePayload({domainSep, kind}, commonRecords({name, symbol, decimals, standards}) ++ records)`. */
  metadata?: { domainSep: string; kind: number; name?: string; symbol?: string; decimals?: number | string; standards?: string | string[] };
}

export interface VerifiedEvent {
  /** Position of the event among the contract's Misc events in this transaction (0-based). */
  index: number;
  id: number;
  contractAddress: string;
  name: string;
  payload: string;
  source?: { transactionHash: string; logicalSegment: number; physicalSegment: number; entryPoint?: string };
  inRawTransaction: boolean;
  segmentApplied: boolean;
  classification: {
    result: Classification['result'];
    reason?: string;
    offset?: number;
    domainSep?: string;
    kind?: number;
    records?: unknown[];
  };
  expectation?: { ok: boolean; differences: string[] };
}

export interface VerifyReport {
  network: { id: string; genesisHash: string; indexer: string; rpc: string };
  contract: string;
  transaction: string;
  outcome: Outcome;
  exitCode: number;
  indexerTip?: { height: number; hash: string };
  inclusion?: {
    height: number;
    hash: string;
    status?: string;
    segments?: { id: number; success: boolean }[] | null;
    nodeBlockHash: string | null;
    finalizedHeight: number;
    finalized: boolean;
    extrinsicIndex?: number;
  };
  rawTransaction?: { hashRecomputed: string; identifiersMatch: boolean; miscLogsOfContract: number; appliedMiscLogsOfContract: number };
  events: VerifiedEvent[];
  checks: Check[];
  notes: string[];
}

export interface VerifyOptions {
  profile: NetworkProfile;
  contract: string;
  tx: string;
  expect?: EventExpectation | EventExpectation[];
  /** Keep polling the indexer for the transaction this long (ms) before deciding not-found / not-indexed. */
  waitMs?: number;
  /** Look for the raw transaction bytes in the node block's extrinsics (one `chain_getBlock`). Default true. */
  extrinsicCheck?: boolean;
  http?: HttpClient;
  sleep?: (ms: number) => Promise<void>;
}

function recordsFromExpectation(rs: NonNullable<EventExpectation['records']>): MetadataRecord[] {
  return rs.map((r) => {
    const key = new TextEncoder().encode(r.key);
    switch (r.valType) {
      case 0:
        return { key, valType: 0, value: hexToBytes(String(r.value)) };
      case 2:
        return rec.uint(r.key, BigInt(r.value));
      case 5:
        return rec.tombstone(r.key);
      default:
        return { key, valType: r.valType, value: new TextEncoder().encode(String(r.value)) };
    }
  });
}

/** The payload an `EventExpectation.metadata` describes. */
export function expectedPayload(m: NonNullable<EventExpectation['metadata']>, extra: EventExpectation['records'] = []): string {
  const fields: Parameters<typeof commonRecords>[0] = {};
  if (m.name !== undefined) fields.name = m.name;
  if (m.symbol !== undefined) fields.symbol = m.symbol;
  if (m.decimals !== undefined) fields.decimals = BigInt(m.decimals);
  if (m.standards !== undefined) fields.standards = m.standards;
  const records = [...commonRecords(fields), ...recordsFromExpectation(extra ?? [])];
  return bytesToHex(encodePayload({ domainSep: hexToBytes(m.domainSep), kind: m.kind }, records));
}

export function compareExpectation(ev: VerifiedEvent, e: EventExpectation): { ok: boolean; differences: string[] } {
  const d: string[] = [];
  const c = ev.classification;
  if (e.result !== undefined && c.result !== e.result) d.push(`result ${c.result}, expected ${e.result}`);
  if (e.reason !== undefined && c.reason !== e.reason) d.push(`reason ${c.reason ?? '-'}, expected ${e.reason}`);
  if (e.name !== undefined && ev.name !== normHex(e.name)) d.push('name bytes differ');
  if (e.payload !== undefined && ev.payload !== normHex(e.payload)) d.push('payload bytes differ');
  if (e.metadata !== undefined) {
    const want = expectedPayload(e.metadata, e.records);
    if (ev.payload !== want) d.push(`payload differs from the expected metadata (want ${want.slice(0, 80)}…)`);
    if (c.result !== 'accept') d.push(`result ${c.result}, expected accept`);
  } else if (e.records !== undefined) {
    const want = recordsFromExpectation(e.records).map((r) => `${bytesToHex(r.key)}:${r.valType}:${bytesToHex(r.value)}`);
    const got = ((c.records ?? []) as { key: string; valType: number; value: string }[]).map((r) => `${r.key}:${r.valType}:${r.value}`);
    if (JSON.stringify(want) !== JSON.stringify(got)) d.push('records differ');
  }
  if (e.domainSep !== undefined && c.domainSep !== normHex(e.domainSep))
    d.push(`domainSep ${c.domainSep ?? '-'}, expected ${normHex(e.domainSep)}`);
  if (e.kind !== undefined && c.kind !== e.kind) d.push(`kind ${c.kind ?? '-'}, expected ${e.kind}`);
  return { ok: d.length === 0, differences: d };
}

/**
 * Classifies a `Misc` event given as hex. A short name or payload is zero-extended first (MIP "Consuming": some sources
 * drop trailing zero bytes); a longer name is another name (ignore) and a longer payload is rejected.
 */
export function classify(nameHex: string, payloadHex: string): VerifiedEvent['classification'] {
  const c = classifyEvent({ type: 'Misc', name: hexToBytes(nameHex), payload: hexToBytes(payloadHex) });
  if (c.result === 'ignore') return { result: 'ignore', reason: c.reason };
  if (c.result === 'reject') return { result: 'reject', reason: c.reason, offset: c.offset };
  return {
    result: 'accept',
    domainSep: bytesToHex(c.header.domainSep),
    kind: c.header.kind,
    records: c.records.map((r) => ({
      key: bytesToHex(r.key),
      keyText: new TextDecoder('utf-8', { fatal: false }).decode(r.key),
      valType: r.valType,
      value: bytesToHex(r.value),
      ...(r.integer !== undefined ? { integer: r.integer.toString() } : {}),
    })),
  };
}

/** Whether the node has the transaction in a recent non-final block (best .. finalized+1). */
async function findPending(rpc: NodeRpc, txHash: string, finalizedHeight: number, maxBlocks = 20): Promise<number | undefined> {
  const best = await rpc.bestHeight();
  for (let h = best; h > finalizedHeight && h > best - maxBlocks; h--) {
    const hash = await rpc.blockHash(h);
    if (hash === null) continue;
    for (const x of await rpc.blockExtrinsics(hash)) if (transactionHashInExtrinsic(x) === txHash) return h;
  }
  return undefined;
}

export async function verifyEmission(o: VerifyOptions): Promise<VerifyReport> {
  const contract = normAddress(o.contract);
  const txHash = normTxHash(o.tx);
  const http = o.http ?? new HttpClient({ minIntervalMs: o.profile.minIntervalMs });
  const indexer = new Indexer(o.profile.indexer, o.profile.indexerWs, http);
  const rpc = new NodeRpc(o.profile.rpc, http);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const checks: Check[] = [];
  const notes: string[] = [];
  const check = (id: string, ok: boolean, message: string) => checks.push({ id, ok, message });

  const genesis = await checkIdentity(o.profile, http);
  check('identity', true, `node genesis ${genesis} (${o.profile.id})`);
  const report: VerifyReport = {
    network: { id: o.profile.id, genesisHash: genesis, indexer: o.profile.indexer, rpc: o.profile.rpc },
    contract,
    transaction: txHash,
    outcome: 'ok',
    exitCode: 0,
    events: [],
    checks,
    notes,
  };
  const finish = (outcome: Outcome): VerifyReport => {
    report.outcome = outcome;
    report.exitCode = EXIT[outcome];
    return report;
  };

  // 2. indexer (bounded wait while the transaction is unknown)
  const until = Date.now() + (o.waitMs ?? 0);
  let bundle: { tip: BlockInfo; events: IndexedMiscEvent[]; transaction: IndexedTransaction | null };
  for (;;) {
    bundle = await indexer.verifyBundle(contract, txHash);
    if (bundle.transaction !== null || Date.now() >= until) break;
    await sleep(2_000);
  }
  report.indexerTip = { height: bundle.tip.height, hash: bundle.tip.hash };
  const t = bundle.transaction;
  if (t === null) {
    const fin = await rpc.finalizedHead();
    if (fin.height > bundle.tip.height + 1) {
      check(
        'indexed',
        false,
        `transaction not indexed; the indexer (tip ${bundle.tip.height}) is behind the node's finalized head ${fin.height}`,
      );
      return finish('not-indexed');
    }
    const pending = await findPending(rpc, txHash, fin.height);
    if (pending !== undefined) {
      check('indexed', false, `transaction is in node block ${pending}, which is not final yet (finalized ${fin.height})`);
      return finish('not-indexed');
    }
    check('indexed', false, `transaction unknown to the indexer (tip ${bundle.tip.height}) and not in the node's recent blocks`);
    return finish('not-found');
  }
  check(
    'indexed',
    true,
    `transaction ${t.hash} in block ${t.block.height} (${t.block.hash}), ${t.transactionResult?.status ?? t.__typename}`,
  );
  report.inclusion = {
    height: t.block.height,
    hash: t.block.hash,
    status: t.transactionResult?.status,
    segments: t.transactionResult?.segments ?? null,
    nodeBlockHash: null,
    finalizedHeight: -1,
    finalized: false,
  };

  // 3. raw transaction
  let decoded: DecodedTransaction | undefined;
  try {
    decoded = decodeTransaction(t.raw);
  } catch (e) {
    check('raw-decode', false, `raw transaction does not decode: ${(e as Error).message}`);
  }
  if (decoded) {
    check('raw-hash', decoded.hash === normHex(t.hash), `recomputed hash ${decoded.hash}`);
    const ids = new Set((t.identifiers ?? []).map((i) => normHex(i)));
    const idsMatch = ids.size === decoded.identifiers.length && decoded.identifiers.every((i) => ids.has(i));
    check(
      'raw-identifiers',
      idsMatch,
      `${decoded.identifiers.length} identifiers recomputed${idsMatch ? '' : `, indexer has ${ids.size}`}`,
    );
    const logs = miscLogsOf(decoded, contract);
    const appliedLogs = logs.filter((l) => partApplied(l.phase, l.segment, t.transactionResult));
    report.rawTransaction = {
      hashRecomputed: decoded.hash,
      identifiersMatch: idsMatch,
      miscLogsOfContract: logs.length,
      appliedMiscLogsOfContract: appliedLogs.length,
    };
    if (logs.length > appliedLogs.length)
      notes.push(`${logs.length - appliedLogs.length} Misc log(s) of the contract are in a failed segment and were not applied`);
  }

  // 4–5. events
  const evs = [...bundle.events].sort((a, b) => a.id - b.id);
  const appliedLogs = decoded ? miscLogsOf(decoded, contract).filter((l) => partApplied(l.phase, l.segment, t.transactionResult)) : [];
  let cursor = 0;
  evs.forEach((e, index) => {
    // MIP "Consuming": treat missing trailing bytes as zero (name 32, payload 256) before comparing or decoding.
    const name = zeroExtendHex(e.name ?? '', 32, 'event name');
    const payload = zeroExtendHex(e.payload ?? '', 256, 'event payload');
    const v: VerifiedEvent = {
      index,
      id: e.id,
      contractAddress: normHex(e.contractAddress),
      name,
      payload,
      inRawTransaction: false,
      segmentApplied: false,
      classification: classify(name, payload),
    };
    try {
      const r = decodeEventRaw(e.raw);
      v.source = {
        transactionHash: r.transactionHash,
        logicalSegment: r.logicalSegment,
        physicalSegment: r.physicalSegment,
        entryPoint: r.entryPoint,
      };
      const okRecord =
        r.tag === 'contractLog' &&
        r.contractAddress === contract &&
        v.contractAddress === contract &&
        r.transactionHash === txHash &&
        r.eventType === 'misc';
      check(
        `event-${index}-record`,
        okRecord,
        `event ${e.id}: bound to ${r.contractAddress ?? '?'} (entry point ${r.entryPoint ?? '?'}), ${r.eventType ?? r.tag}`,
      );
      v.segmentApplied = partApplied(
        r.logicalSegment === 0 ? 'guaranteed' : 'fallible',
        r.logicalSegment === 0 ? r.physicalSegment : r.logicalSegment,
        t.transactionResult,
      );
      // match the next applied log op of the contract with the same segment and bytes
      for (let i = cursor; i < appliedLogs.length; i++) {
        const l = appliedLogs[i]!;
        if (l.segment === r.physicalSegment && l.name === name && l.payload === payload) {
          v.inRawTransaction = true;
          cursor = i + 1;
          break;
        }
      }
    } catch (err) {
      check(`event-${index}-record`, false, `event ${e.id}: raw event does not decode: ${(err as Error).message}`);
    }
    check(
      `event-${index}-in-raw-tx`,
      v.inRawTransaction,
      `event ${e.id}: ${v.inRawTransaction ? 'equals' : 'does NOT equal'} a log op of the contract in the raw transaction`,
    );
    check(`event-${index}-segment`, v.segmentApplied, `event ${e.id}: its segment ${v.segmentApplied ? 'applied' : 'did NOT apply'}`);
    report.events.push(v);
  });
  if (decoded) {
    check(
      'completeness',
      appliedLogs.length === evs.length,
      `${appliedLogs.length} applied Misc log(s) of the contract in the raw transaction, ${evs.length} indexed`,
    );
  }

  // 6. node
  const nodeHash = await rpc.blockHash(t.block.height);
  report.inclusion.nodeBlockHash = nodeHash;
  check('node-block-hash', nodeHash === `0x${normHex(t.block.hash)}`, `node block ${t.block.height} = ${nodeHash ?? 'none'}`);
  const fin = await rpc.finalizedHead();
  report.inclusion.finalizedHeight = fin.height;
  report.inclusion.finalized = fin.height >= t.block.height;
  if (o.extrinsicCheck ?? true) {
    const idx = await rpc.findRawTransaction(t.block.hash, t.raw);
    report.inclusion.extrinsicIndex = idx;
    check(
      'node-extrinsic',
      idx >= 0,
      idx >= 0
        ? `raw transaction bytes are extrinsic ${idx} of block ${t.block.height}`
        : 'raw transaction bytes not found in the node block',
    );
  }

  // 7. expectation
  if (o.expect !== undefined) {
    const list = Array.isArray(o.expect) ? o.expect : [o.expect];
    if (list.length !== report.events.length) check('expect-count', false, `${report.events.length} event(s), ${list.length} expected`);
    list.forEach((e, i) => {
      const ev = report.events[i];
      if (!ev) return;
      ev.expectation = compareExpectation(ev, e);
      check(
        `expect-${i}`,
        ev.expectation.ok,
        ev.expectation.ok ? `event ${ev.id} matches the expectation` : `event ${ev.id}: ${ev.expectation.differences.join('; ')}`,
      );
    });
  }

  if (report.events.length === 0) {
    check('events', false, `the transaction holds no Misc event bound to ${contract}`);
    if (checks.every((c) => c.ok || c.id === 'events')) return finish('not-found');
  }
  if (checks.some((c) => !c.ok)) return finish('mismatch');
  if (!report.inclusion.finalized) {
    check('finalized', false, `block ${t.block.height} is not finalized on the node yet (finalized ${fin.height})`);
    return finish('not-indexed');
  }
  check('finalized', true, `block ${t.block.height} ≤ finalized ${fin.height}`);
  return finish('ok');
}

export { EVENT_NAME };
