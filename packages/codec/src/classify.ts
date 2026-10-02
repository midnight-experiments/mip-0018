// Event classification (MIP "Event"): ignore anything that is not a `Misc` event with the exact v1 name; otherwise
// decode the payload and accept or reject the whole event.
import { EVENT_NAME, type IgnoreReason, MISC_EVENT_TYPE, NAME_SIZE, PAYLOAD_SIZE, type RejectReason } from './constants.ts';
import { decodePayloadWith, type DecodedRecord, type Header } from './decode.ts';
import { bytesEqual } from './hex.ts';
import { ALL_CODEC_RULES, type CodecRules } from './rules.ts';

export interface ObservedMisc {
  /** MIP-0002 `LogEventType` name, e.g. `Misc`. */
  type: string;
  /** The event's 32-byte name. */
  name: Uint8Array;
  /** The event's 256-byte payload. */
  payload: Uint8Array;
}

export type Classification =
  | { result: 'accept'; header: Header; records: DecodedRecord[]; contentEnd: number }
  | { result: 'reject'; reason: RejectReason; offset: number }
  | { result: 'ignore'; reason: IgnoreReason };

export function isMip0018Name(name: Uint8Array): boolean {
  return name.length === NAME_SIZE && bytesEqual(name, EVENT_NAME);
}

/** Classifies one observed event: `ignore` (not ours), `reject` (ours but invalid), or `accept` with the records. */
export function classifyEvent(event: ObservedMisc): Classification {
  return classifyEventWith(event, ALL_CODEC_RULES);
}

/** `classifyEvent` with explicit rule switches (rule-mutation testing only). */
export function classifyEventWith(event: ObservedMisc, rules: CodecRules): Classification {
  if (rules.typeCheck && event.type !== MISC_EVENT_TYPE) return { result: 'ignore', reason: 'not-misc' };
  if (rules.nameCheck && !isMip0018Name(event.name)) return { result: 'ignore', reason: 'other-name' };
  const d = decodePayloadWith(event.payload, rules);
  if (!d.ok) return { result: 'reject', reason: d.reason, offset: d.offset };
  return { result: 'accept', header: d.header, records: d.records, contentEnd: d.contentEnd };
}

/**
 * Splits raw `Misc` log data (`name ‖ payload`, 288 bytes) into name and payload. Some sources (raw ledger data, the
 * Compact runtime) drop trailing zero bytes; the data is zero-extended to 288 bytes first (proposal note N2).
 * Returns `undefined` when the data is longer than 288 bytes.
 */
export function splitMiscData(data: Uint8Array): { name: Uint8Array; payload: Uint8Array } | undefined {
  const total = NAME_SIZE + PAYLOAD_SIZE;
  if (data.length > total) return undefined;
  const full = new Uint8Array(total);
  full.set(data, 0);
  return { name: full.slice(0, NAME_SIZE), payload: full.slice(NAME_SIZE) };
}
