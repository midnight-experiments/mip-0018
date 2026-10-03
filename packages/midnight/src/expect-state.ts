// SPDX-License-Identifier: Apache-2.0
//
// Expected consumer state of one contract, and the comparison `mip0018 list --expect` / `recheck` make.
//
// The shape is the `expected` object of the examples' metadata.json (examples/openzeppelin/README.md#metadatajson),
// which is also what deployments/stagenet/cases/<ID>/expected.json holds:
//
//   { "identities": [ { "domainSep": "0x…", "kind": 1|2|3, "colored": bool,
//                       "common": { "name"?, "symbol"?, "decimals"? (number), "standards"? (space-joined) },
//                       "fields"?: { "<key hex>": { "key_text", "valType", "value_hex", "usable"? } } } ],
//     "groups": [ { "symbol": "<text>", "members": [ { "domainSep": "0x…", "kind" } ] } ],
//     "counts"?: { "events"?, "accepted"?, "rejected"?, "ignored"? } }
//
// Identities are matched by (domainSep, kind): the observed set must equal the expected set. Only identities that have
// at least one field exist (MIP "Applying records": once its last field is deleted, an identity is not referenced at
// all), so a withdrawn identity is simply not listed. `fields` and `counts` are compared only when the expectation has
// them (metadata.json files do not; the raw-emitter cases do). Colors are not part of the expectation (they depend on
// the deployed address); `colored` says whether one is derived, and `recheck` compares the actual colors with the
// scanner and the wallet. A property outside this shape is refused.

import type { IdentityView, SymbolGroup } from '@mip0018/consumer';
import { bytesToHex, normHex } from './hex.ts';

export interface ExpectedField {
  key_text?: string;
  valType: number;
  value_hex: string;
  usable?: boolean;
}

export interface ExpectedIdentity {
  domainSep: string;
  kind: number;
  colored: boolean;
  common: Record<string, unknown>;
  fields?: Record<string, ExpectedField>;
}

export interface ExpectedGroup {
  symbol: string;
  members: { domainSep: string; kind: number }[];
}

export interface ExpectedCounts {
  events?: number;
  accepted?: number;
  rejected?: number;
  ignored?: number;
}

export interface ExpectedState {
  identities: ExpectedIdentity[];
  groups: ExpectedGroup[];
  counts?: ExpectedCounts;
}

export class ExpectationError extends Error {
  override name = 'ExpectationError';
}

/** Accepts an expected-state object or any object holding one under `expected` (an example's metadata.json). */
export function expectedStateFrom(json: unknown): ExpectedState {
  const o = json as { expected?: { identities?: unknown; groups?: unknown } };
  const inner = o && typeof o === 'object' ? o.expected : undefined;
  const s = (inner && typeof inner === 'object' && Array.isArray(inner.identities) ? inner : o) as ExpectedState;
  if (!s || !Array.isArray(s.identities) || !Array.isArray(s.groups))
    throw new ExpectationError('an expected state needs "identities" and "groups" arrays (or an "expected" object holding them)');
  checkShape(s);
  return s;
}

const SHAPE = {
  state: ['identities', 'groups', 'counts'],
  identity: ['domainSep', 'kind', 'colored', 'common', 'fields'],
  common: ['name', 'symbol', 'decimals', 'standards'],
  field: ['key_text', 'valType', 'value_hex', 'usable'],
  group: ['symbol', 'members'],
  member: ['domainSep', 'kind'],
  counts: ['events', 'accepted', 'rejected', 'ignored'],
} as const;

/** Every object of the expectation holds only the properties of its shape (the header comment above). */
function checkShape(s: ExpectedState): void {
  const only = (o: unknown, allowed: readonly string[], where: string) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ExpectationError(`${where} must be an object`);
    for (const k of Object.keys(o))
      if (!allowed.includes(k)) throw new ExpectationError(`${where}: unknown property "${k}" (allowed: ${allowed.join(', ')})`);
  };
  only(s, SHAPE.state, 'expected state');
  if (s.counts !== undefined) only(s.counts, SHAPE.counts, 'expected counts');
  s.identities.forEach((i, n) => {
    const where = `expected identity #${n}`;
    only(i, SHAPE.identity, where);
    only(i.common, SHAPE.common, `${where} common`);
    if (i.fields !== undefined) {
      if (!i.fields || typeof i.fields !== 'object') throw new ExpectationError(`${where} fields must be an object`);
      for (const [k, f] of Object.entries(i.fields)) only(f, SHAPE.field, `${where} field ${k}`);
    }
  });
  s.groups.forEach((g, n) => {
    only(g, SHAPE.group, `expected group #${n}`);
    (Array.isArray(g.members) ? g.members : []).forEach((m, j) => only(m, SHAPE.member, `expected group #${n} member #${j}`));
  });
}

const dec = new TextDecoder();
const x0 = (h: string) => `0x${normHex(h)}`;

/** The common fields of an identity in the metadata.json shape. */
export function commonOf(v: IdentityView): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (v.common.name !== undefined) c.name = v.common.name;
  if (v.common.symbol !== undefined) c.symbol = v.common.symbol;
  if (v.common.decimals !== undefined) {
    const d = v.common.decimals;
    c.decimals = d <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(d) : d.toString();
  }
  if (v.common.standards !== undefined) c.standards = v.common.standards.join(' ');
  return c;
}

/** Observed consumer state (one contract) in the expected-state shape, with every field. */
export function projectState(identities: IdentityView[], groups: SymbolGroup[], counts?: ExpectedCounts): ExpectedState {
  return {
    identities: identities.map((v) => ({
      domainSep: x0(v.domainSep),
      kind: v.kind,
      colored: v.colored,
      common: commonOf(v),
      fields: Object.fromEntries(
        v.fields.map((f) => [
          f.keyHex,
          {
            key_text: dec.decode(f.key),
            valType: f.valType,
            value_hex: bytesToHex(f.value),
            ...(f.usable !== undefined ? { usable: f.usable } : {}),
          },
        ]),
      ),
    })),
    groups: groups.map((g) => ({
      symbol: dec.decode(g.symbol),
      members: g.members.map((m) => ({ domainSep: x0(m.domainSep), kind: m.kind })),
    })),
    ...(counts ? { counts } : {}),
  };
}

const idKey = (i: { domainSep: string; kind: number }) => `${normHex(i.domainSep)}/${i.kind}`;
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x as object)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
const groupKey = (g: ExpectedGroup) => `${g.symbol}|${g.members.map(idKey).sort().join(',')}`;

/** Compares an observed state (projectState) with an expectation; returns every difference. */
export function compareState(observed: ExpectedState, expected: ExpectedState): { ok: boolean; differences: string[] } {
  const d: string[] = [];
  const obs = new Map(observed.identities.map((i) => [idKey(i), i]));
  const exp = new Map(expected.identities.map((i) => [idKey(i), i]));
  for (const k of exp.keys()) if (!obs.has(k)) d.push(`identity ${k} expected, not observed`);
  for (const k of obs.keys()) if (!exp.has(k)) d.push(`identity ${k} observed, not expected`);
  for (const [k, e] of exp) {
    const o = obs.get(k);
    if (!o) continue;
    if (o.colored !== e.colored) d.push(`${k}: colored ${o.colored}, expected ${e.colored}`);
    if (canon(o.common) !== canon(e.common)) d.push(`${k}: common ${canon(o.common)}, expected ${canon(e.common)}`);
    if (e.fields !== undefined) {
      const of = o.fields ?? {};
      for (const key of new Set([...Object.keys(of), ...Object.keys(e.fields)])) {
        const a = of[normHex(key)] ?? of[key];
        const b = e.fields[key];
        if (!a) d.push(`${k}: field ${key} expected, not observed`);
        else if (!b) d.push(`${k}: field ${key} (${a.key_text ?? ''}) observed, not expected`);
        else {
          if (a.valType !== b.valType) d.push(`${k}: field ${key} valType ${a.valType}, expected ${b.valType}`);
          if (normHex(a.value_hex) !== normHex(b.value_hex)) d.push(`${k}: field ${key} value ${a.value_hex}, expected ${b.value_hex}`);
          if (b.usable !== undefined && a.usable !== b.usable) d.push(`${k}: field ${key} usable ${a.usable}, expected ${b.usable}`);
        }
      }
    }
  }
  const og = observed.groups.map(groupKey).sort();
  const eg = expected.groups.map(groupKey).sort();
  if (canon(og) !== canon(eg)) d.push(`groups ${JSON.stringify(og)}, expected ${JSON.stringify(eg)}`);
  if (expected.counts) {
    for (const [k, v] of Object.entries(expected.counts)) {
      const got = (observed.counts as Record<string, number> | undefined)?.[k];
      if (v !== undefined && got !== v) d.push(`counts.${k} ${got ?? '-'}, expected ${v}`);
    }
  }
  return { ok: d.length === 0, differences: d };
}
