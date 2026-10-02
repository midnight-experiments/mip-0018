// The runner-protocol adapter for the reference consumer (vectors/README.md, "Runner contract";
// vectors/schema/runner.schema.json). One request object in, one response object out.
import { fromHex, toHex } from '@mip0018/codec';
import { ALL_CODEC_RULES, classifyEventWith, type CodecRules } from '@mip0018/codec/internal';
import { type ConsumerRules } from './rules.ts';
import { MetadataState, type IdentityView } from './state.ts';

type Json = Record<string, unknown>;

export interface AdapterOptions {
  /** Testing only (rule mutations). */
  rules?: Partial<ConsumerRules>;
  /** Testing only (rule mutations). */
  codecRules?: Partial<CodecRules>;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`);
  return v;
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new TypeError(`${what} must be a non-negative integer`);
  return v;
}

/**
 * An event's name or payload as observed. Any length is passed on: the codec zero-extends a short `name` (32 bytes) or
 * `payload` (256 bytes), ignores a longer name and rejects a longer payload (MIP "Consuming").
 */
function observed(v: unknown, what: string): Uint8Array {
  return fromHex(str(v, what));
}

function decodeResponse(id: unknown, req: Json, codecRules: CodecRules): Json {
  const c = classifyEventWith(
    { type: str(req.type, 'type'), name: observed(req.name_hex, 'name_hex'), payload: observed(req.payload_hex, 'payload_hex') },
    codecRules,
  );
  if (c.result === 'ignore') return { id, result: 'ignore', reason: c.reason };
  if (c.result === 'reject') return { id, result: 'reject', reason: c.reason, offset: c.offset };
  return {
    id,
    result: 'accept',
    header: { domainSep: toHex(c.header.domainSep), kind: c.header.kind },
    records: c.records.map((r) => {
      const o: Json = { offset: r.offset, key_hex: toHex(r.key), valType: r.valType, value_hex: toHex(r.value) };
      if (r.integer !== undefined) o.decoded = r.integer.toString();
      return o;
    }),
    contentEnd: c.contentEnd,
  };
}

function identityJson(v: IdentityView): Json {
  const fields: Json = {};
  for (const f of v.fields) {
    const o: Json = { valType: f.valType, value_hex: toHex(f.value) };
    if (f.usable !== undefined) o.usable = f.usable;
    fields[f.keyHex] = o;
  }
  return {
    network: v.network,
    contractAddress: v.contractAddress,
    domainSep: v.domainSep,
    kind: v.kind,
    visible: v.visible,
    colored: v.colored,
    fields,
  };
}

function stateResponse(id: unknown, req: Json, opts: AdapterOptions): Json {
  if (!Array.isArray(req.steps)) throw new TypeError('steps must be an array');
  const stateOpts: ConstructorParameters<typeof MetadataState>[0] = {};
  if (opts.rules !== undefined) stateOpts.rules = opts.rules;
  if (opts.codecRules !== undefined) stateOpts.codecRules = opts.codecRules;
  const state = new MetadataState(stateOpts);
  for (const [i, s] of (req.steps as unknown[]).entries()) {
    if (typeof s !== 'object' || s === null) throw new TypeError(`steps[${i}] must be an object`);
    const step = s as Json;
    if (step.op === 'apply') {
      state.apply({
        network: str(step.network, 'network'),
        contractAddress: str(step.contractAddress, 'contractAddress'),
        block: int(step.block, 'block'),
        tx: int(step.tx, 'tx'),
        event: int(step.event, 'event'),
        type: str(step.type, 'type'),
        name: observed(step.name_hex, 'name_hex'),
        payload: observed(step.payload_hex, 'payload_hex'),
      });
    } else if (step.op === 'rollback') {
      state.rollbackTo(str(step.network, 'network'), int(step.toBlock, 'toBlock'));
    } else {
      throw new TypeError(`steps[${i}]: unknown op ${String(step.op)}`);
    }
  }
  const identities = state.identities();
  const display: Json[] = [];
  for (const q of Array.isArray(req.display) ? (req.display as Json[]) : []) {
    const raw = BigInt(str(q.raw, 'raw'));
    const view = state.identity(
      str(q.network, 'network'),
      str(q.contractAddress, 'contractAddress'),
      str(q.domainSep, 'domainSep'),
      int(q.kind, 'kind'),
    );
    const d = state.display(view, raw);
    display.push({
      network: q.network,
      contractAddress: q.contractAddress,
      domainSep: q.domainSep,
      kind: q.kind,
      raw: q.raw,
      decimals: d.decimals === null ? null : d.decimals.toString(),
      text: d.text,
    });
  }
  return {
    id,
    identities: identities.map(identityJson),
    groups: state.groups().map((g) => ({
      network: g.network,
      contractAddress: g.contractAddress,
      symbol_hex: toHex(g.symbol),
      members: g.members.map((m) => ({ domainSep: m.domainSep, kind: m.kind })),
    })),
    display,
  };
}

/** Handles one runner-protocol request. Never throws: failures become `{id, error}`. */
export function handleRequest(request: unknown, opts: AdapterOptions = {}): Json {
  const id = typeof request === 'object' && request !== null && typeof (request as Json).id === 'string' ? (request as Json).id : null;
  try {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new TypeError('request must be a JSON object');
    const req = request as Json;
    if (req.op === 'decode') return decodeResponse(id, req, { ...ALL_CODEC_RULES, ...(opts.codecRules ?? {}) });
    if (req.op === 'state') return stateResponse(id, req, opts);
    throw new TypeError(`unknown op ${String(req.op)}`);
  } catch (e) {
    return { id, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** Handles one protocol line (a JSON request) and returns the response line (without the newline). */
export function handleLine(line: string, opts: AdapterOptions = {}): string {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return JSON.stringify({ id: null, error: `invalid JSON request: ${(e as Error).message}` });
  }
  return JSON.stringify(handleRequest(request, opts));
}
