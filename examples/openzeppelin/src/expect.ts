// SPDX-License-Identifier: Apache-2.0
// Assertions shared by the OpenZeppelin example tests (vitest only; scripts import src/testing.ts).
import { classifyEvent, decodePayload, decodeUtf8, EVENT_NAME, toHex } from '@mip0018/codec';
import { expect } from 'vitest';
import type { CallOutcome, ExpectedEvent, ExpectedState, Step } from './testing.ts';

/**
 * The emitted payload, decoded with @mip0018/codec, carries exactly the metadata.json values: the
 * header, the keys in order, and each value byte for byte — a UTF-8 value decodes to the very same
 * string (no zero padding: a `Bytes<K>` wider than its value would append 0x00 bytes, which the MIP
 * treats as a different value), `decimals` is a 1-byte `Uint<8>`, a tombstone is Null at `name`.
 */
export const expectExactRecords = (payload: Uint8Array, e: ExpectedEvent, label: string): void => {
  const d = decodePayload(payload);
  if (!d.ok) throw new Error(`${label}: payload rejected (${d.reason})`);
  expect(toHex(d.header.domainSep), `${label}: domainSep`).toBe(e.domainSep.replace(/^0x/u, ''));
  expect(d.header.kind, `${label}: kind`).toBe(e.kind);
  const text = (k: string) => (e as Record<string, unknown>)[k];
  const want: [string, number, unknown][] = e.tombstone
    ? [['name', 5, '']]
    : (['name', 'symbol', 'decimals', 'standards'] as const)
        .filter((k) => text(k) !== undefined)
        .map((k) => [k, k === 'decimals' ? 2 : 1, text(k)]);
  const got = d.records.map((r) => {
    const key = decodeUtf8(r.key);
    if (r.valType === 2) return [key, 2, r.value.length === 1 ? Number(r.integer) : `width ${r.value.length}`];
    return [key, r.valType, decodeUtf8(r.value)];
  });
  expect(got, `${label}: records (key, valType, value)`).toEqual(want);
  for (const r of d.records)
    if (r.valType === 1) expect(r.value.at(-1), `${label}: ${decodeUtf8(r.key)} ends with a zero byte`).not.toBe(0);
};

/** The call emitted exactly the step's events, in order: MIP-0018 name, bound to `address`, metadata.json bytes and values, accepted. */
export const expectStepEvents = (out: CallOutcome, step: Step, address: string): void => {
  expect(out.misc, `${step.id}: number of Misc events`).toHaveLength(step.events.length);
  step.events.forEach((e, i) => {
    const m = out.misc[i]!;
    expect(m.address, `${step.id}: event ${i} address`).toBe(address);
    expect(toHex(m.name), `${step.id}: event ${i} name`).toBe(toHex(EVENT_NAME));
    expect(toHex(m.payload), `${step.id}: event ${i} payload`).toBe(e.payload);
    expectExactRecords(m.payload, e, `${step.id}: event ${i}`);
    expect(classifyEvent({ type: 'Misc', name: m.name, payload: m.payload }).result).toBe('accept');
  });
  expect(out.events.length, `${step.id}: only Misc events`).toBe(out.misc.length);
};

/** Identities and group members in a stable order, so states compare regardless of first-seen order. */
export const sortedState = (s: ExpectedState): ExpectedState => {
  const id = (x: { domainSep: string; kind: number }) => `${x.domainSep}|${x.kind}`;
  const groups = s.groups.map((g) => ({ ...g, members: [...g.members].sort((a, b) => id(a).localeCompare(id(b))) }));
  return {
    identities: [...s.identities].sort((a, b) => id(a).localeCompare(id(b))),
    groups: groups.sort((a, b) => (a.symbol + id(a.members[0]!)).localeCompare(b.symbol + id(b.members[0]!))),
  };
};
