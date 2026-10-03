// SPDX-License-Identifier: Apache-2.0
//
// The expected-state comparison behind `list --expect` and `recheck`: projection of the reference consumer's state
// into the metadata.json `expected` shape, and every kind of difference it must report.

import { describe, expect, it } from 'vitest';
import { commonRecords, encodePayload, EVENT_NAME, record, withdrawRecords } from '@mip0018/codec';
import { MetadataState } from '@mip0018/consumer';
import { compareState, expectedStateFrom, projectState, tokenType, type ExpectedState } from '../src/index.ts';

const ADDR = 'ab'.repeat(32);
const DS = '11'.repeat(32);
const name = new Uint8Array(32);
name.set(EVENT_NAME);

function stateOf(payloads: Uint8Array[]): MetadataState {
  const s = new MetadataState({ tokenType });
  payloads.forEach((p, i) =>
    s.apply({
      network: 'undeployed',
      contractAddress: Buffer.from(ADDR, 'hex'),
      block: i + 1,
      tx: 0,
      event: 0,
      type: 'Misc',
      name,
      payload: p,
    }),
  );
  return s;
}
const p = (kind: number, f: Parameters<typeof commonRecords>[0]) =>
  encodePayload({ domainSep: Buffer.from(DS, 'hex'), kind }, commonRecords(f));

const A1: ExpectedState = {
  identities: [
    {
      domainSep: `0x${DS}`,
      kind: 3,
      colored: false,
      common: { name: 'Acme Token', symbol: 'ACME', decimals: 6, standards: 'mip-0004' },
    },
  ],
  groups: [{ symbol: 'ACME', members: [{ domainSep: `0x${DS}`, kind: 3 }] }],
};

describe('expected state', () => {
  const s = stateOf([p(3, { name: 'Acme Token', symbol: 'ACME', decimals: 6n, standards: ['mip-0004'] })]);
  const observed = projectState(s.identities(), s.groups(), { events: 1, accepted: 1, rejected: 0, ignored: 0 });

  it('projects the consumer state into the metadata.json shape and matches A1', () => {
    expect(observed.identities[0]).toMatchObject(A1.identities[0]!);
    expect(Object.keys(observed.identities[0]!.fields!)).toHaveLength(4);
    expect(compareState(observed, A1)).toEqual({ ok: true, differences: [] });
    // a metadata.json (expected under "expected") is accepted as the expectation
    expect(expectedStateFrom({ example: 'x', identities: [], expected: A1 })).toBe(A1);
    expect(() => expectedStateFrom({ foo: 1 })).toThrow(/identities/);
  });

  it('reports every difference', () => {
    const wrong: ExpectedState = JSON.parse(JSON.stringify(A1));
    wrong.identities[0]!.colored = true;
    wrong.identities[0]!.common.symbol = 'ACMX';
    wrong.groups = [];
    wrong.counts = { rejected: 1 };
    const d = compareState(observed, wrong).differences.join('\n');
    expect(d).toMatch(/colored false, expected true/);
    expect(d).toMatch(/common/);
    expect(d).toMatch(/groups/);
    expect(d).toMatch(/counts.rejected 0, expected 1/);
    const missing: ExpectedState = { identities: [{ ...A1.identities[0]!, kind: 1, colored: true }], groups: A1.groups };
    const m = compareState(observed, missing).differences.join('\n');
    expect(m).toMatch(/\/1 expected, not observed/);
    expect(m).toMatch(/\/3 observed, not expected/);
  });

  it('compares fields exactly when the expectation lists them (key, type, bytes, usability)', () => {
    const withFields: ExpectedState = JSON.parse(JSON.stringify(A1));
    withFields.identities[0]!.fields = observed.identities[0]!.fields;
    expect(compareState(observed, withFields).ok).toBe(true);
    const f = JSON.parse(JSON.stringify(withFields)) as ExpectedState;
    const nameKey = Buffer.from('name').toString('hex');
    f.identities[0]!.fields![nameKey]!.value_hex = Buffer.from('Acme Token\0').toString('hex');
    expect(compareState(observed, f).differences.join()).toMatch(/field 6e616d65 value/);
    delete f.identities[0]!.fields![nameKey];
    expect(compareState(observed, f).differences.join()).toMatch(/observed, not expected/);
  });

  it('a Null record deletes its field only; the identity keeps its other fields and its group (colored kinds 1/2)', () => {
    const t = stateOf([
      p(1, { name: 'A', symbol: 'AA' }),
      encodePayload({ domainSep: Buffer.from(DS, 'hex'), kind: 1 }, [record.tombstone('name')]),
    ]);
    const o = projectState(t.identities(), t.groups());
    expect(
      compareState(o, {
        identities: [{ domainSep: `0x${DS}`, kind: 1, colored: true, common: { symbol: 'AA' } }],
        groups: [{ symbol: 'AA', members: [{ domainSep: `0x${DS}`, kind: 1 }] }],
      }),
    ).toEqual({ ok: true, differences: [] });
  });

  it('withdraw (a Null record for each key): the identity is not listed at all, no group, as if never described', () => {
    const t = stateOf([
      p(1, { name: 'A', symbol: 'AA', decimals: 6n, standards: ['mip-0011'] }),
      encodePayload({ domainSep: Buffer.from(DS, 'hex'), kind: 1 }, withdrawRecords()),
    ]);
    const o = projectState(t.identities(), t.groups());
    expect(o).toEqual({ identities: [], groups: [] });
    expect(compareState(o, { identities: [], groups: [] })).toEqual({ ok: true, differences: [] });
    // an expectation that still lists it (in any form) fails
    expect(compareState(o, { identities: [{ domainSep: `0x${DS}`, kind: 1, colored: true, common: {} }], groups: [] }).ok).toBe(false);
  });

  it('refuses an expectation file that still uses the removed `visible` property', () => {
    const old = { identities: [{ domainSep: `0x${DS}`, kind: 1, visible: false, colored: true, common: {} }], groups: [] };
    expect(() => expectedStateFrom(old)).toThrow(/"visible": that property was removed with MIP 274a84f/);
  });
});
