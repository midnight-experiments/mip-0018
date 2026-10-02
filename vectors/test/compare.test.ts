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
  const visible = { ...ID, visible: true, fields: { '6e616d65': { valType: 1, value_hex: '41', usable: true } } };
  it('a hidden identity without fields equals an absent one (both directions)', () => {
    expect(compareState({ identities: [{ ...ID, visible: false, fields: {} }] }, { identities: [] }).ok).toBe(true);
    expect(compareState({ identities: [] }, { identities: [{ ...ID, visible: false, fields: {} }] }).ok).toBe(true);
  });
  it('a hidden identity that still has fields fails', () => {
    const got = { identities: [{ ...ID, visible: false, fields: visible.fields }] };
    expect(compareState({ identities: [{ ...ID, visible: false, fields: {} }] }, got).ok).toBe(false);
  });
  it('extra fields and extra identities fail', () => {
    const extraField = { ...visible, fields: { ...visible.fields, '78': { valType: 0, value_hex: '' } } };
    expect(compareState({ identities: [visible] }, { identities: [extraField] }).ok).toBe(false);
    expect(compareState({ identities: [visible] }, { identities: [visible, { ...visible, kind: 2 }] }).ok).toBe(false);
  });
  it('usable is compared only when expected', () => {
    const noUsable = { ...visible, fields: { '6e616d65': { valType: 1, value_hex: '41' } } };
    expect(compareState({ identities: [noUsable] }, { identities: [visible] }).ok).toBe(true);
    expect(compareState({ identities: [visible] }, { identities: [noUsable] }).ok).toBe(false);
  });
  it('groups compare as sets; display by identity and raw', () => {
    const g = {
      network: 'n',
      contractAddress: 'aa'.repeat(32),
      symbol_hex: '41',
      members: [
        { domainSep: '11'.repeat(32), kind: 1 },
        { domainSep: '11'.repeat(32), kind: 3 },
      ],
    };
    const g2 = { ...g, members: [...g.members].reverse() };
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [g2] }).ok).toBe(true);
    expect(compareState({ identities: [], groups: [g] }, { identities: [], groups: [] }).ok).toBe(false);
    const d = { ...ID, raw: '123456', decimals: '2', text: '1234.56' };
    expect(compareState({ identities: [], display: [d] }, { identities: [], display: [d] }).ok).toBe(true);
    expect(compareState({ identities: [], display: [d] }, { identities: [], display: [{ ...d, text: '1234.560' }] }).ok).toBe(false);
  });
});
