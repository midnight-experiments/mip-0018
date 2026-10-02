// SPDX-License-Identifier: Apache-2.0
// Assertions shared by the OpenZeppelin example tests (vitest only; scripts import src/testing.ts).
import { classifyEvent, EVENT_NAME, toHex } from '@mip0018/codec';
import { expect } from 'vitest';
import type { CallOutcome, ExpectedState, Step } from './testing.ts';

/** The call emitted exactly the step's events, in order: MIP-0018 name, bound to `address`, metadata.json bytes, accepted. */
export const expectStepEvents = (out: CallOutcome, step: Step, address: string): void => {
  expect(out.misc, `${step.id}: number of Misc events`).toHaveLength(step.events.length);
  step.events.forEach((e, i) => {
    const m = out.misc[i]!;
    expect(m.address, `${step.id}: event ${i} address`).toBe(address);
    expect(toHex(m.name), `${step.id}: event ${i} name`).toBe(toHex(EVENT_NAME));
    expect(toHex(m.payload), `${step.id}: event ${i} payload`).toBe(e.payload);
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
