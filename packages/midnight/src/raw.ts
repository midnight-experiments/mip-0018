// SPDX-License-Identifier: Apache-2.0
//
// Raw transaction decoding with ledger-v9 (the ground truth an indexer's view is checked against).
//
// From a serialized transaction (`midnight:transaction[v12](signature[v2],proof,pedersen-schnorr[v1])`, the
// indexer's `Transaction.raw`) this recomputes the hash and identifiers and collects, for every action:
//
//   * contract calls: the `log` operations of the guaranteed and fallible transcripts (each `log` pops the value
//     pushed right before it: the VersionedLogItem `[version, eventType, data]`; for `Misc` the data cell is the
//     288-byte `name ‖ payload` with trailing zero bytes stripped — it is zero-extended back to 288 here, per the
//     MIP's Consuming section) and the transcript effects `shieldedMints` / `unshieldedMints` (domainSep → amount);
//   * contract deploys (address) and maintenance updates (address, counter, updates).
//
// Ordering is deterministic and follows the ledger's event order (midnight-ledger `semantics.rs`), which MIP-0018
// states in "Applying records" since 78ecbb4: first the guaranteed phase — intents in ascending segment id, actions in
// intent order, operations in program order — then each fallible segment in ascending segment id (test:
// test/event-order.test.ts). Within one transcript, mints are listed in ascending domainSep.
// `applied()` keeps only what actually took effect: guaranteed parts unless the transaction FAILED; a fallible part
// only when its segment succeeded.

import { ContractCall, ContractDeploy, Event, MaintenanceUpdate, Transaction } from '@midnightntwrk/ledger-v9';
import { NAME_SIZE, PAYLOAD_SIZE, splitMiscData } from '@mip0018/codec';
import { bytesToHex, hexToBytes, normHex } from './hex.ts';
import type { TransactionResult } from './indexer.ts';

/** MIP-0002 `LogEventType` code of `Misc`. */
export const MISC_EVENT_TYPE_CODE = 10;
export const MISC_DATA_SIZE = NAME_SIZE + PAYLOAD_SIZE;

export const LOG_EVENT_TYPES = [
  'shielded-spend',
  'shielded-receive',
  'shielded-mint',
  'shielded-burn',
  'unshielded-spend',
  'unshielded-receive',
  'unshielded-mint',
  'unshielded-burn',
  'paused',
  'unpaused',
  'misc',
] as const;

export type Phase = 'guaranteed' | 'fallible';

export interface Placement {
  phase: Phase;
  /** The intent's segment id (the event's `physicalSegment`); the logical segment is 0 for the guaranteed phase. */
  segment: number;
  /** Index of the action in its intent. */
  actionIndex: number;
  contractAddress: string;
  entryPoint: string;
}

export interface DecodedLog extends Placement {
  /** Index of the `log` op in the transcript program. */
  opIndex: number;
  version: number | null;
  eventTypeCode: number | null;
  eventType: string | null;
  /** Misc only: the data atom zero-extended to 288 bytes (hex), split into name and payload. */
  name?: string;
  payload?: string;
  /** Why the log could not be read as a Misc `name ‖ payload` (when it is a log of another shape). */
  undecodable?: string;
}

export interface DecodedMint extends Placement {
  kind: 'shielded' | 'unshielded';
  domainSep: string;
  amount: bigint;
}

export interface DecodedDeploy {
  segment: number;
  actionIndex: number;
  address: string;
}

export interface DecodedMaintenance {
  segment: number;
  actionIndex: number;
  address: string;
  counter: bigint;
  updates: string[];
}

export interface DecodedTransaction {
  hash: string;
  identifiers: string[];
  segments: number[];
  calls: { segment: number; actionIndex: number; contractAddress: string; entryPoint: string; phases: Phase[] }[];
  deploys: DecodedDeploy[];
  maintenance: DecodedMaintenance[];
  /** Every log op, in ledger event order. */
  logs: DecodedLog[];
  /** Every mint effect, in ledger order. */
  mints: DecodedMint[];
}

export class RawDecodeError extends Error {
  override name = 'RawDecodeError';
}

type Encoded = { tag: string; content?: unknown };
type Aligned = { value: Uint8Array[] };

const entryPointText = (e: Uint8Array | string): string => (typeof e === 'string' ? e : Buffer.from(e).toString('utf8'));

function leUint(bytes: Uint8Array): number {
  let n = 0;
  for (let i = bytes.length - 1; i >= 0; i--) n = n * 256 + (bytes[i] as number);
  return n;
}

function singleAtom(v: Encoded | undefined): Uint8Array | undefined {
  if (v?.tag !== 'cell') return undefined;
  const atoms = (v.content as Aligned).value;
  return atoms.length === 1 ? (atoms[0] as Uint8Array) : atoms.length === 0 ? new Uint8Array(0) : undefined;
}

/** Reads the VersionedLogItem pushed before a `log` op. */
export function readLogItem(
  pushed: unknown,
): Pick<DecodedLog, 'version' | 'eventTypeCode' | 'eventType' | 'name' | 'payload' | 'undecodable'> {
  const v = pushed as Encoded | undefined;
  if (v?.tag !== 'array' || !Array.isArray(v.content) || v.content.length !== 3) {
    return { version: null, eventTypeCode: null, eventType: null, undecodable: 'not a [version, eventType, data] array' };
  }
  const [ver, et, data] = v.content as Encoded[];
  const verBytes = singleAtom(ver);
  const etBytes = singleAtom(et);
  const version = verBytes === undefined ? null : leUint(verBytes);
  const eventTypeCode = etBytes === undefined ? null : leUint(etBytes);
  const eventType = eventTypeCode === null ? null : (LOG_EVENT_TYPES[eventTypeCode] ?? null);
  const out: ReturnType<typeof readLogItem> = { version, eventTypeCode, eventType };
  if (eventTypeCode !== MISC_EVENT_TYPE_CODE) return out;
  const atom = singleAtom(data);
  if (atom === undefined) return { ...out, undecodable: 'Misc data is not a single cell atom' };
  if (atom.length > MISC_DATA_SIZE) return { ...out, undecodable: `Misc data is ${atom.length} bytes (> 288)` };
  const split = splitMiscData(atom);
  if (split === undefined) return { ...out, undecodable: 'Misc data cannot be split' };
  return { ...out, name: bytesToHex(split.name), payload: bytesToHex(split.payload) };
}

type Transcript = { program: unknown[]; effects: { shieldedMints: Map<string, bigint>; unshieldedMints: Map<string, bigint> } };

function transcriptParts(t: Transcript, place: Placement): { logs: DecodedLog[]; mints: DecodedMint[] } {
  const logs: DecodedLog[] = [];
  t.program.forEach((op, i) => {
    if (op !== 'log') return;
    const prev = t.program[i - 1] as { push?: { value: unknown } } | undefined;
    const item = prev?.push
      ? readLogItem(prev.push.value)
      : { version: null, eventTypeCode: null, eventType: null, undecodable: 'the logged value was not pushed right before the log op' };
    logs.push({ ...place, opIndex: i, ...item });
  });
  const mints: DecodedMint[] = [];
  for (const [kind, map] of [
    ['shielded', t.effects.shieldedMints],
    ['unshielded', t.effects.unshieldedMints],
  ] as const) {
    for (const [ds, amount] of [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      mints.push({ ...place, kind, domainSep: normHex(ds), amount: BigInt(amount) });
    }
  }
  return { logs, mints };
}

/** Deserializes a finalized transaction (the indexer's `raw`). */
export function deserializeTransaction(raw: Uint8Array | string): Transaction<never, never, never> {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
  try {
    return Transaction.deserialize('signature', 'proof', 'binding', bytes) as never;
  } catch (e) {
    throw new RawDecodeError(`not a finalized ledger-v9 transaction: ${(e as Error).message}`);
  }
}

/** Decodes a finalized transaction object or its serialized bytes. */
export function decodeTransaction(input: Uint8Array | string | { serialize(): Uint8Array }): DecodedTransaction {
  const tx = (typeof input === 'object' && 'serialize' in input && !(input instanceof Uint8Array)
    ? input
    : deserializeTransaction(input)) as unknown as {
    transactionHash(): string;
    identifiers(): string[];
    intents?: Map<number, { actions: unknown[] }>;
  };
  const intents = [...(tx.intents ?? new Map<number, { actions: unknown[] }>())].sort(([a], [b]) => a - b);
  const out: DecodedTransaction = {
    hash: normHex(tx.transactionHash()),
    identifiers: tx.identifiers().map((i) => normHex(i)),
    segments: intents.map(([s]) => s),
    calls: [],
    deploys: [],
    maintenance: [],
    logs: [],
    mints: [],
  };
  const fallible: { logs: DecodedLog[]; mints: DecodedMint[] }[] = [];
  for (const [segment, intent] of intents) {
    const segFallible = { logs: [] as DecodedLog[], mints: [] as DecodedMint[] };
    intent.actions.forEach((action, actionIndex) => {
      if (action instanceof ContractCall) {
        const contractAddress = normHex(action.address);
        const entryPoint = entryPointText(action.entryPoint);
        const phases: Phase[] = [];
        if (action.guaranteedTranscript) {
          phases.push('guaranteed');
          const p = transcriptParts(action.guaranteedTranscript as unknown as Transcript, {
            phase: 'guaranteed',
            segment,
            actionIndex,
            contractAddress,
            entryPoint,
          });
          out.logs.push(...p.logs);
          out.mints.push(...p.mints);
        }
        if (action.fallibleTranscript) {
          phases.push('fallible');
          const p = transcriptParts(action.fallibleTranscript as unknown as Transcript, {
            phase: 'fallible',
            segment,
            actionIndex,
            contractAddress,
            entryPoint,
          });
          segFallible.logs.push(...p.logs);
          segFallible.mints.push(...p.mints);
        }
        out.calls.push({ segment, actionIndex, contractAddress, entryPoint, phases });
      } else if (action instanceof ContractDeploy) {
        out.deploys.push({ segment, actionIndex, address: normHex(action.address) });
      } else if (action instanceof MaintenanceUpdate) {
        out.maintenance.push({
          segment,
          actionIndex,
          address: normHex(action.address),
          counter: BigInt(action.counter),
          updates: action.updates.map((u) => String((u as { toString(): string }).toString())),
        });
      }
    });
    fallible.push(segFallible);
  }
  for (const f of fallible) {
    out.logs.push(...f.logs);
    out.mints.push(...f.mints);
  }
  return out;
}

/** Whether a part placed in `phase`/`segment` took effect, given the transaction result. */
export function partApplied(phase: Phase, segment: number, result: TransactionResult | undefined): boolean {
  if (result === undefined) return false;
  if (result.status === 'FAILURE') return false;
  if (phase === 'guaranteed') return true;
  if (result.status === 'SUCCESS') return true;
  return (result.segments ?? []).some((s) => s.id === segment && s.success);
}

/** The logs and mints that took effect (successful segments only). */
export function applied(d: DecodedTransaction, result: TransactionResult | undefined): { logs: DecodedLog[]; mints: DecodedMint[] } {
  return {
    logs: d.logs.filter((l) => partApplied(l.phase, l.segment, result)),
    mints: d.mints.filter((m) => partApplied(m.phase, m.segment, result)),
  };
}

/** Misc logs of one contract (MIP-0018 or not), in ledger order. */
export function miscLogsOf(d: DecodedTransaction | { logs: DecodedLog[] }, contractAddress: string): DecodedLog[] {
  const a = normHex(contractAddress);
  return d.logs.filter((l) => l.contractAddress === a && l.eventTypeCode === MISC_EVENT_TYPE_CODE);
}

export interface DecodedEventRaw {
  transactionHash: string;
  logicalSegment: number;
  physicalSegment: number;
  tag: string;
  contractAddress?: string;
  entryPoint?: string;
  version?: number;
  eventType?: string;
}

/** Decodes an indexer `ContractEvent.raw` (`midnight:event[v14]:…`, a tagged ledger `Event`). */
export function decodeEventRaw(raw: string | Uint8Array): DecodedEventRaw {
  let ev: Event;
  try {
    ev = Event.deserialize(typeof raw === 'string' ? hexToBytes(raw) : raw);
  } catch (e) {
    throw new RawDecodeError(`not a ledger-v9 event: ${(e as Error).message}`);
  }
  const c = ev.content as {
    tag: string;
    address?: string;
    entryPoint?: Uint8Array | string;
    loggedItem?: { version: number; eventType: string };
  };
  const out: DecodedEventRaw = {
    transactionHash: normHex(ev.source.transactionHash),
    logicalSegment: ev.source.logicalSegment,
    physicalSegment: ev.source.physicalSegment,
    tag: c.tag,
  };
  if (c.address !== undefined) out.contractAddress = normHex(c.address);
  if (c.entryPoint !== undefined) out.entryPoint = entryPointText(c.entryPoint);
  if (c.loggedItem !== undefined) {
    out.version = c.loggedItem.version;
    out.eventType = c.loggedItem.eventType;
  }
  return out;
}

const TX_TAG_HEX = Buffer.from('midnight:transaction[', 'utf8').toString('hex');

/**
 * Looks for a serialized transaction inside a node extrinsic (hex) and returns its hash, or undefined. The extrinsic
 * wraps the transaction bytes (SCALE); the transaction starts at its tag and runs to the end of the extrinsic.
 */
export function transactionHashInExtrinsic(extrinsicHex: string): string | undefined {
  const x = normHex(extrinsicHex);
  for (let at = x.indexOf(TX_TAG_HEX); at >= 0; at = x.indexOf(TX_TAG_HEX, at + 1)) {
    if (at % 2 !== 0) continue;
    try {
      return normHex(deserializeTransaction(x.slice(at)).transactionHash());
    } catch {
      /* not a whole transaction from here; keep looking */
    }
  }
  return undefined;
}
