// The reference reducer (MIP "Applying records", "Common fields", "Symbol grouping", "Token identity").
//
// - Events are applied in chain order per network: (block, tx, event) must strictly increase; records within an
//   event apply in order. An out-of-order event throws `ChainOrderError` (the caller's bug, not the chain's).
// - Every accepted event is retained per network, so a reorganization (`rollbackTo`) recomputes the state from the
//   remaining canonical events — the only way to restore values a tombstone deleted.
// - Token identity = (network, contractAddress from the event record, domainSep, kind).
// - A Null record (tombstone) deletes its own field. A token identity exists only while at least one of its fields
//   has a value: once its last field is deleted it is not referenced at all (listings, lookups, groups, history), as
//   if it had never been described, and Null records alone never create one (MIP "Applying records").
// - The color of kinds 1 and 2 comes from an injected `tokenType(domainSep, contractAddress)` (ledger-specific; this
//   package stays dependency-free); kind 3 never gets a color and the hook is never called for it.
import { toHex, ValType, type DecodedRecord, type Header, type IgnoreReason, type RejectReason } from '@mip0018/codec';
import { ALL_CODEC_RULES, classifyEventWith, type CodecRules } from '@mip0018/codec/internal';
import {
  COMMON_KEYS,
  commonFieldUsable,
  formatAmount,
  KEY_DECIMALS,
  KEY_NAME,
  KEY_STANDARDS,
  KEY_SYMBOL,
  parseStandards,
} from './common.ts';
import { ALL_CONSUMER_RULES, type ConsumerRules } from './rules.ts';

/** One event as observed on a network (MIP-0002 contract log event). */
export interface ObservedEvent {
  network: string;
  /** The address of the contract the event is bound to — from the event record, never from the payload. */
  contractAddress: Uint8Array | string;
  block: bigint | number;
  tx: number;
  event: number;
  /** MIP-0002 `LogEventType` name. */
  type: string;
  name: Uint8Array;
  payload: Uint8Array;
}

/** Ledger `tokenType(domainSep, contractAddress)` (raw 32-byte color). Implemented outside this package. */
export type TokenTypeFn = (domainSep: Uint8Array, contractAddress: Uint8Array) => Uint8Array;

export interface Position {
  block: bigint;
  tx: number;
  event: number;
}

export interface FieldValue {
  key: Uint8Array;
  valType: number;
  value: Uint8Array;
  /** valType 2: the decoded integer. */
  integer?: bigint;
  /** Where the value was set (record index within the event). */
  setAt: Position & { record: number };
}

export interface HistoryEntry extends FieldValue {
  /** Where the value stopped being current. Marked history: never current, never a fallback. */
  replacedAt: Position & { record: number };
}

export interface FieldView extends FieldValue {
  keyHex: string;
  /** Common keys only: whether the current value has the type and form the MIP requires. */
  usable?: boolean;
}

export interface CommonFields {
  name?: string;
  symbol?: string;
  decimals?: bigint;
  /** Claimed standard identifiers; `[]` when `standards` is empty. Absent when unset or unusable. */
  standards?: string[];
}

export interface IdentityView {
  /** Stable key `network|contractAddress|domainSep|kind`. */
  key: string;
  network: string;
  contractAddress: string;
  domainSep: string;
  kind: number;
  /** Whether a color is derived for this identity (kinds 1 and 2). */
  colored: boolean;
  /** The color, when `colored` and a `tokenType` hook was given. */
  color: Uint8Array | null;
  /** Every field with a current value; never empty (an identity without fields is not referenced). */
  fields: FieldView[];
  /** Usable values of the common fields only (no defaults, no fallbacks). */
  common: CommonFields;
}

export interface SymbolGroup {
  network: string;
  contractAddress: string;
  symbol: Uint8Array;
  members: Array<{ domainSep: string; kind: number; key: string }>;
}

export type ApplyResult =
  | { result: 'accept'; identity: string; records: number }
  | { result: 'reject'; reason: RejectReason; offset: number }
  | { result: 'ignore'; reason: IgnoreReason };

export interface DisplayResult {
  /** The identity's usable `decimals`, or `null` (never a default). */
  decimals: bigint | null;
  /** `amount / 10^decimals`, or `null` when there is no usable `decimals`. */
  text: string | null;
}

export class ChainOrderError extends Error {
  override name = 'ChainOrderError';
}

export interface MetadataStateOptions {
  tokenType?: TokenTypeFn;
  /**
   * Keep replaced values as marked history (MAY). A Null record drops its own field's history; when the identity's
   * last field is deleted, the identity goes with all its history. Default false.
   */
  keepHistory?: boolean;
  /** Testing only: disable reducer rules (rule-mutation test). */
  rules?: Partial<ConsumerRules>;
  /** Testing only: disable decoder rules (rule-mutation test). */
  codecRules?: Partial<CodecRules>;
}

interface Identity {
  key: string;
  network: string;
  contractAddress: Uint8Array;
  domainSep: Uint8Array;
  kind: number;
  fields: Map<string, FieldValue>;
  history: Map<string, HistoryEntry[]>;
}

interface Retained {
  position: Position;
  contractAddress: Uint8Array;
  header: Header;
  records: DecodedRecord[];
}

function comparePosition(a: Position, b: Position): number {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  if (a.tx !== b.tx) return a.tx < b.tx ? -1 : 1;
  if (a.event !== b.event) return a.event < b.event ? -1 : 1;
  return 0;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h))
    throw new TypeError('contractAddress must be non-empty hex or bytes');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function nonNegativeInt(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(`${what} must be a non-negative integer`);
  return v;
}

/** Mutation only (`exactKeys: false`): case-fold ASCII and drop trailing zero bytes. */
function foldKey(key: Uint8Array): Uint8Array {
  let end = key.length;
  while (end > 0 && key[end - 1] === 0) end--;
  return key.slice(0, end).map((b) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b));
}

/** Mutation only (`emptyIsValue: false`): treat empty strings/bytes and JSON null as tombstones. */
function looksEmpty(r: DecodedRecord): boolean {
  if ((r.valType === ValType.Bytes || r.valType === ValType.Utf8) && r.value.length === 0) return true;
  return r.valType === ValType.Json && new TextDecoder().decode(r.value).trim() === 'null';
}

export class MetadataState {
  private readonly identitiesByKey = new Map<string, Identity>();
  private readonly retained = new Map<string, Retained[]>();
  private readonly last = new Map<string, Position>();
  private readonly tokenType: TokenTypeFn | undefined;
  private readonly keepHistory: boolean;
  private readonly rules: ConsumerRules;
  private readonly codecRules: CodecRules;

  constructor(opts: MetadataStateOptions = {}) {
    this.tokenType = opts.tokenType;
    this.keepHistory = opts.keepHistory ?? false;
    this.rules = { ...ALL_CONSUMER_RULES, ...(opts.rules ?? {}) };
    this.codecRules = { ...ALL_CODEC_RULES, ...(opts.codecRules ?? {}) };
  }

  /** Classifies an observed event and, if accepted, applies its records. Events must arrive in chain order per network. */
  apply(ev: ObservedEvent): ApplyResult {
    if (typeof ev.network !== 'string' || ev.network.length === 0) throw new TypeError('network must be a non-empty string');
    const contract = typeof ev.contractAddress === 'string' ? hexToBytes(ev.contractAddress) : ev.contractAddress.slice();
    if (contract.length === 0) throw new TypeError('contractAddress must not be empty');
    const position: Position = { block: BigInt(ev.block), tx: nonNegativeInt(ev.tx, 'tx'), event: nonNegativeInt(ev.event, 'event') };
    if (position.block < 0n) throw new TypeError('block must be non-negative');
    const prev = this.last.get(ev.network);
    if (prev !== undefined && comparePosition(position, prev) <= 0) {
      throw new ChainOrderError(
        `event (${position.block}, ${position.tx}, ${position.event}) on ${ev.network} is not after (${prev.block}, ${prev.tx}, ${prev.event})`,
      );
    }
    this.last.set(ev.network, position);

    const c = classifyEventWith({ type: ev.type, name: ev.name, payload: ev.payload }, this.codecRules);
    if (c.result !== 'accept') return c;
    const kept: Retained = { position, contractAddress: contract, header: c.header, records: c.records };
    const list = this.retained.get(ev.network) ?? [];
    list.push(kept);
    this.retained.set(ev.network, list);
    const key = this.applyAccepted(ev.network, kept);
    return { result: 'accept', identity: key, records: c.records.length };
  }

  /**
   * Reorganization: removes every event above `block` on `network` and recomputes that network's state from the
   * remaining accepted events. The next event on that network must be in a later block.
   */
  rollbackTo(network: string, block: bigint | number): void {
    const b = BigInt(block);
    const list = this.retained.get(network) ?? [];
    this.retained.set(
      network,
      list.filter((e) => e.position.block <= b),
    );
    const prev = this.last.get(network);
    if (prev !== undefined && prev.block > b)
      this.last.set(network, { block: b, tx: Number.POSITIVE_INFINITY, event: Number.POSITIVE_INFINITY });
    if (!this.rules.rollbackRecompute) return; // mutation only
    for (const [k, id] of this.identitiesByKey) if (id.network === network) this.identitiesByKey.delete(k);
    for (const e of this.retained.get(network) ?? []) this.applyAccepted(network, e);
  }

  /**
   * Every token identity that currently has at least one field, in the order they were (last) described. An identity
   * whose last field was deleted is not listed, exactly as one that was never described.
   */
  identities(): IdentityView[] {
    return [...this.identitiesByKey.values()].map((id) => this.view(id));
  }

  /** One identity, or `undefined` if it has no field (never described, or every field deleted). */
  identity(network: string, contractAddress: Uint8Array | string, domainSep: Uint8Array | string, kind: number): IdentityView | undefined {
    const c = typeof contractAddress === 'string' ? contractAddress.toLowerCase() : toHex(contractAddress);
    const d = typeof domainSep === 'string' ? domainSep.toLowerCase() : toHex(domainSep);
    const id = this.identitiesByKey.get(this.identityKey(network, c, d, kind));
    return id === undefined ? undefined : this.view(id);
  }

  /** Marked history of one field (only with `keepHistory`); emptied by a Null record at that key. */
  history(identityKey: string, keyHex: string): HistoryEntry[] {
    return [...(this.identitiesByKey.get(identityKey)?.history.get(keyHex.toLowerCase()) ?? [])];
  }

  /**
   * Symbol groups: identities of one (network, contractAddress) with the same usable `symbol`, compared as exact
   * bytes. Every identity with a usable symbol is in exactly one group (single-member groups included — a choice of
   * this reference; the vector runner compares only groups of two or more members, MIP Testing S9). An identity whose
   * `symbol` was deleted has no symbol and is ungrouped; a removed identity is in no group.
   */
  groups(): SymbolGroup[] {
    const groups = new Map<string, SymbolGroup>();
    for (const id of this.identitiesByKey.values()) {
      const sym = id.fields.get(KEY_SYMBOL);
      if (sym === undefined) continue;
      const usable = this.rules.groupUsableOnly
        ? commonFieldUsable(KEY_SYMBOL, sym.valType, sym.value, this.rules) === true
        : sym.value.length > 0;
      if (!usable) continue;
      const symKey = this.rules.groupExactBytes ? toHex(sym.value) : new TextDecoder().decode(sym.value).trim().toLowerCase();
      const contractHex = toHex(id.contractAddress);
      const gk = this.rules.groupWithinContract ? `${id.network}|${contractHex}|${symKey}` : `${id.network}|${symKey}`;
      let g = groups.get(gk);
      if (g === undefined) {
        g = { network: id.network, contractAddress: contractHex, symbol: sym.value.slice(), members: [] };
        groups.set(gk, g);
      }
      g.members.push({ domainSep: toHex(id.domainSep), kind: id.kind, key: id.key });
    }
    const out = [...groups.values()];
    for (const g of out) g.members.sort((a, b) => (a.domainSep === b.domainSep ? a.kind - b.kind : a.domainSep < b.domainSep ? -1 : 1));
    return out;
  }

  /** Displays a raw amount of an identity with its current usable `decimals` (no default when there is none). */
  display(identity: IdentityView | undefined, raw: bigint): DisplayResult {
    const f = identity?.fields.find((x) => x.keyHex === KEY_DECIMALS);
    if (identity === undefined || f === undefined || f.usable !== true || f.integer === undefined) return { decimals: null, text: null };
    if (!this.rules.displayDecimals) return { decimals: f.integer, text: raw.toString() }; // mutation only
    return { decimals: f.integer, text: formatAmount(raw, f.integer) };
  }

  // ------------------------------------------------------------------------------------------------------------

  private identityKey(network: string, contractHex: string, domainSepHex: string, kind: number): string {
    return [
      this.rules.identityNetwork ? network : '*',
      this.rules.identityContract ? contractHex : '*',
      domainSepHex,
      this.rules.identityKind ? String(kind) : '*',
    ].join('|');
  }

  private applyAccepted(network: string, e: Retained): string {
    const key = this.identityKey(network, toHex(e.contractAddress), toHex(e.header.domainSep), e.header.kind);
    const create = (): Identity => {
      const id: Identity = {
        key,
        network,
        contractAddress: e.contractAddress,
        domainSep: e.header.domainSep,
        kind: e.header.kind,
        fields: new Map(),
        history: new Map(),
      };
      this.identitiesByKey.set(key, id);
      return id;
    };
    // Mutation only (keepEmptyIdentity): any accepted event creates the identity, and it stays without fields.
    if (!this.rules.removeEmptyIdentity && !this.identitiesByKey.has(key)) create();
    const indexed = e.records.map((r, i) => ({ r, i }));
    if (!this.rules.recordOrder) indexed.reverse(); // mutation only
    for (const { r, i } of indexed) {
      const at = { ...e.position, record: i };
      const storedKey = this.rules.exactKeys ? r.key : foldKey(r.key);
      const keyHex = toHex(storedKey);
      const tombstone = r.valType === ValType.Null || (!this.rules.emptyIsValue && looksEmpty(r));
      if (tombstone) {
        if (!this.rules.tombstoneDeletes) continue; // mutation only: Null records ignored
        // A Null record for a field that has no value has no effect — and never creates an identity.
        const id = this.identitiesByKey.get(key);
        if (id === undefined) continue;
        if (this.rules.tombstonePerKey) {
          // Delete this field: its value and its earlier values (history). Nothing falls back.
          id.fields.delete(keyHex);
          id.history.delete(keyHex);
        } else {
          // Mutation only (tombstoneIdentityWide, the rule of MIP 78ecbb4): delete every field of the identity.
          id.fields.clear();
          id.history.clear();
        }
        // The last field is gone: the identity is no longer referenced anywhere, as if it had never been described.
        if (id.fields.size === 0 && this.rules.removeEmptyIdentity) this.identitiesByKey.delete(key);
        continue;
      }
      // A non-Null record describes the identity (again, with only this field if every field had been deleted).
      const id = this.identitiesByKey.get(key) ?? create();
      const previous = id.fields.get(keyHex);
      const next: FieldValue = { key: storedKey.slice(), valType: r.valType, value: r.value, setAt: at };
      if (r.integer !== undefined) next.integer = r.integer;
      if (previous !== undefined) {
        if (!this.rules.latestWins) continue; // mutation only: first value wins
        if (!this.rules.noFallback && COMMON_KEYS.has(keyHex)) {
          // mutation only: keep an earlier usable value when the new one is unusable
          const prevOk = commonFieldUsable(keyHex, previous.valType, previous.value, this.rules) === true;
          const nextOk = commonFieldUsable(keyHex, next.valType, next.value, this.rules) === true;
          if (prevOk && !nextOk) continue;
        }
        if (this.keepHistory) {
          const h = id.history.get(keyHex) ?? [];
          h.push({ ...previous, replacedAt: at });
          id.history.set(keyHex, h);
        }
      }
      id.fields.set(keyHex, next);
    }
    return key;
  }

  private view(id: Identity): IdentityView {
    const colored = this.rules.colorNativeOnly ? id.kind === 1 || id.kind === 2 : true;
    const color =
      colored && this.tokenType !== undefined && (id.kind === 1 || id.kind === 2)
        ? this.tokenType(id.domainSep.slice(), id.contractAddress.slice())
        : null;
    const fields: FieldView[] = [];
    const common: CommonFields = {};
    for (const [keyHex, f] of id.fields) {
      const usable = commonFieldUsable(keyHex, f.valType, f.value, this.rules);
      const fv: FieldView = { ...f, keyHex };
      if (usable !== undefined) fv.usable = usable;
      fields.push(fv);
      if (usable !== true) continue;
      const text = new TextDecoder().decode(f.value);
      if (keyHex === KEY_NAME) common.name = text;
      else if (keyHex === KEY_SYMBOL) common.symbol = text;
      else if (keyHex === KEY_DECIMALS && f.integer !== undefined) common.decimals = f.integer;
      else if (keyHex === KEY_STANDARDS) common.standards = parseStandards(f.value) ?? [];
    }
    return {
      key: id.key,
      network: id.network,
      contractAddress: toHex(id.contractAddress),
      domainSep: toHex(id.domainSep),
      kind: id.kind,
      colored,
      color,
      fields,
      common,
    };
  }
}
