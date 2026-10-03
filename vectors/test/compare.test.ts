// Comparison rules of the runner contract (vectors/README.md, "Comparison").
import { describe, expect, it } from 'vitest';
import { compareDecode, compareState } from '../tools/compare.ts';

const ID = { network: 'n', contractAddress: 'aa'.repeat(32), domainSep: '11'.repeat(32), kind: 1 };

describe('compareDecode', () => {
  const accept = {
    result: 'accept',
    header: { domainSep: '11'.repeat(32), kind: 3 },
    records: [{ offset: 33, key_hex: '6e616d65', valType: 1, value_hex: '41', decoded: undefined }],
    contentEnd: 41,
  };
  it('reason and offset differences are notes, not failures', () => {
    const c = compareDecode({ result: 'reject', reason: 'bad-kind', offset: 32 }, { result: 'reject', reason: 'other', offset: 1 });
    expect(c.ok).toBe(true);
    expect(c.notes.length).toBe(2);
  });
  it('a different result fails', () => {
    expect(compareDecode({ result: 'ignore' }, { result: 'reject' }).ok).toBe(false);
  });
  it('contentEnd is derived from the last record when the consumer omits it', () => {
    const got = { result: 'accept', header: accept.header, records: [{ offset: 33, key_hex: '6e616d65', valType: 1, value_hex: '41' }] };
    expect(compareDecode({ ...accept, records: got.records }, got).ok).toBe(true);
  });
  it('hex is compared case-insensitively', () => {
    const got = {
      result: 'accept',
      header: { domainSep: '11'.repeat(32).toUpperCase(), kind: 3 },
      records: [{ offset: 33, key_hex: '6E616D65', valType: 1, value_hex: '41' }],
      contentEnd: 41,
    };
    expect(compareDecode({ ...accept, records: [got.records[0]!].map((r) => ({ ...r, key_hex: '6e616d65' })) }, got).ok).toBe(true);
  });
});

describe('compareState', () => {
  const described = { ...ID, fields: { '6e616d65': { valType: 1, value_hex: '41', usable: true } } };
  it('an identity whose last field was deleted: a consumer that omits it passes, one that reports it without fields fails', () => {
    // MIP "Applying records": "Once its last field is deleted, consumers MUST NOT reference the identity at all".
    expect(compareState({ identities: [] }, { identities: [] }).ok).toBe(true);
    const empty = compareState({ identities: [] }, { identities: [{ ...ID, fields: {} }] });
    expect(empty.ok).toBe(false);
    expect(empty.failures.join()).toMatch(/reported without fields — .*MUST NOT be referenced/);
    expect(compareState({ identities: [] }, { identities: [{ ...ID }] }).ok).toBe(false);
    // Next to an identity that exists, an empty one still fails.
    expect(compareState({ identities: [described] }, { identities: [described, { ...ID, kind: 3, fields: {} }] }).ok).toBe(false);
  });
  it('an identity reported with fields where the expectation has none fails (withdrawn = absent, never kept with values)', () => {
    const c = compareState({ identities: [] }, { identities: [described] });
    expect(c.ok).toBe(false);
    expect(c.failures.join()).toMatch(/not expected/);
  });
  it('an expected identity that is not reported fails', () => {
    const c = compareState({ identities: [described] }, { identities: [] });
    expect(c.ok).toBe(false);
    expect(c.failures.join()).toMatch(/not reported/);
  });
  it('extra fields and extra identities fail', () => {
    const extraField = { ...described, fields: { ...described.fields, '78': { valType: 0, value_hex: '' } } };
    expect(compareState({ identities: [described] }, { identities: [extraField] }).ok).toBe(false);
    expect(compareState({ identities: [described] }, { identities: [described, { ...described, kind: 2 }] }).ok).toBe(false);
  });
  it('usable is compared only when expected', () => {
    const noUsable = { ...described, fields: { '6e616d65': { valType: 1, value_hex: '41' } } };
    expect(compareState({ identities: [noUsable] }, { identities: [described] }).ok).toBe(true);
    expect(compareState({ identities: [described] }, { identities: [noUsable] }).ok).toBe(false);
  });
  const g = {
    network: 'n',
    contractAddress: 'aa'.repeat(32),
    symbol_hex: '41',
    members: [
      { domainSep: '11'.repeat(32), kind: 1 },
      { domainSep: '11'.repeat(32), kind: 3 },
    ],
  };
  const single = { ...g, symbol_hex: '42', members: [{ domainSep: '22'.repeat(32), kind: 3 }] };

  it('groups of two or more members compare as sets; display by identity and raw', () => {
    const g2 = { ...g, members: [...g.members].reverse() };
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [g2] }).ok).toBe(true);
    const d = { ...ID, raw: '123456', decimals: '2', text: '1234.56' };
    expect(compareState({ identities: [], display: [d] }, { identities: [], display: [d] }).ok).toBe(true);
    expect(compareState({ identities: [], display: [d] }, { identities: [], display: [{ ...d, text: '1234.560' }] }).ok).toBe(false);
  });

  it('S9: a consumer that reports no groups passes, with the group check marked not applicable', () => {
    for (const got of [
      { identities: [] },
      { identities: [], groups: [] },
      { identities: [], groups: null },
      { identities: [], groups: [single] },
    ]) {
      const c = compareState({ identities: [], groups: [g, single] }, got);
      expect(c.ok).toBe(true);
      expect(c.notApplicable).toHaveLength(1);
      expect(c.notApplicable[0]).toMatch(/no groups at all/);
    }
  });

  it('S9: single-member groups are ignored on both sides', () => {
    const c = compareState({ identities: [], groups: [g, single] }, { identities: [], groups: [g] });
    expect(c).toEqual({ ok: true, failures: [], notes: [], notApplicable: [] });
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [g, single] }).ok).toBe(true);
  });

  it('S9: a consumer that groups wrongly fails (wrong members, a group too many, a group missing, a duplicate)', () => {
    const wrong = { ...g, members: [...g.members, { domainSep: '33'.repeat(32), kind: 3 }] };
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [wrong] }).ok).toBe(false);
    const other = { ...g, symbol_hex: '61', members: g.members };
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [g, other] }).ok).toBe(false);
    expect(compareState({ identities: [], groups: [g, other] }, { identities: [], groups: [g] }).ok).toBe(false);
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [g, g] }).ok).toBe(false);
    expect(compareState({ identities: [], groups: [] }, { identities: [], groups: [g] }).ok).toBe(false);
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: 'none' }).ok).toBe(false);
  });

  it('S8: a consumer that omits display passes with the display check not applicable; an empty list fails', () => {
    const d = { ...ID, raw: '123456', decimals: '2', text: '1234.56' };
    for (const got of [{ identities: [] }, { identities: [], display: null }]) {
      const c = compareState({ identities: [], display: [d] }, got);
      expect(c.ok).toBe(true);
      expect(c.notApplicable[0]).toMatch(/does not display amounts/);
    }
    expect(compareState({ identities: [], display: [d] }, { identities: [], display: [] }).ok).toBe(false);
  });

  it('fields other than the four common keys are optional; when reported they must match', () => {
    const note = { valType: 1, value_hex: '', key_text: 'note' };
    const exp = { identities: [{ ...described, fields: { ...described.fields, '6e6f7465': note } }] };
    const without = compareState(exp, { identities: [described] });
    expect(without.ok).toBe(true);
    expect(without.notes.join()).toMatch(/not reported \(allowed: not a common key/);
    expect(
      compareState(exp, { identities: [{ ...described, fields: { ...described.fields, '6e6f7465': { valType: 1, value_hex: '' } } }] }).ok,
    ).toBe(true);
    expect(
      compareState(exp, { identities: [{ ...described, fields: { ...described.fields, '6e6f7465': { valType: 0, value_hex: '' } } }] }).ok,
    ).toBe(false);
  });

  it('a missing common key fails (name, symbol, decimals, standards)', () => {
    for (const key of ['6e616d65', '73796d626f6c', '646563696d616c73', '7374616e6461726473']) {
      const other = { '78': { valType: 0, value_hex: '' } };
      const exp = { identities: [{ ...ID, fields: { [key]: { valType: 1, value_hex: '41' }, ...other } }] };
      const c = compareState(exp, { identities: [{ ...ID, fields: other }] });
      expect(c.ok, key).toBe(false);
      expect(c.failures.join()).toMatch(/missing/);
    }
  });
});
