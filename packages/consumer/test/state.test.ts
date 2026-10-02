// Reducer behaviour beyond the vectors: chain-order assertion, rollback edge cases, marked history, per-key
// tombstones and identity removal, color hook, common-field views and display without decimals.
import { encodePayload, EVENT_NAME, record, commonRecords } from '@mip0018/codec';
import { describe, expect, it, vi } from 'vitest';
import { ChainOrderError, MetadataState, type ObservedEvent } from '../src/index.ts';

const D = new Uint8Array(32).fill(0x11);
const A = 'aa'.repeat(32);
const NAME = '6e616d65';
const SYMBOL = '73796d626f6c';
const DECIMALS = '646563696d616c73';
const STANDARDS = '7374616e6461726473';
const ev = (block: number, kind: number, records: Parameters<typeof encodePayload>[1], o: Partial<ObservedEvent> = {}): ObservedEvent => ({
  network: 'n',
  contractAddress: A,
  block,
  tx: 0,
  event: 0,
  type: 'Misc',
  name: EVENT_NAME,
  payload: encodePayload({ domainSep: D, kind }, records),
  ...o,
});

describe('chain order', () => {
  it('rejects a repeated or earlier position per network, and allows other networks independently', () => {
    const s = new MetadataState();
    s.apply(ev(5, 3, [record.utf8('name', 'A')], { tx: 1, event: 2 }));
    expect(() => s.apply(ev(5, 3, [record.utf8('name', 'B')], { tx: 1, event: 2 }))).toThrow(ChainOrderError);
    expect(() => s.apply(ev(5, 3, [record.utf8('name', 'B')], { tx: 0, event: 9 }))).toThrow(ChainOrderError);
    expect(() => s.apply(ev(4, 3, [record.utf8('name', 'B')]))).toThrow(ChainOrderError);
    s.apply(ev(1, 3, [record.utf8('name', 'other')], { network: 'm' }));
    s.apply(ev(5, 3, [record.utf8('name', 'C')], { tx: 1, event: 3 }));
    expect(s.identity('n', A, D, 3)?.common.name).toBe('C');
  });
  it('rejected and ignored events also advance the position', () => {
    const s = new MetadataState();
    expect(s.apply({ ...ev(1, 3, [record.utf8('name', 'A')]), type: 'Paused' }).result).toBe('ignore');
    expect(() => s.apply(ev(1, 3, [record.utf8('name', 'A')]))).toThrow(ChainOrderError);
  });
  it('after a rollback the next event must be above the rollback height', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [record.utf8('name', 'A')]));
    s.apply(ev(3, 3, [record.utf8('name', 'B')]));
    s.rollbackTo('n', 2);
    expect(s.identity('n', A, D, 3)?.common.name).toBe('A');
    expect(() => s.apply(ev(2, 3, [record.utf8('name', 'X')], { tx: 5 }))).toThrow(ChainOrderError);
    s.apply(ev(3, 3, [record.utf8('name', 'C')]));
    expect(s.identity('n', A, D, 3)?.common.name).toBe('C');
  });
  it('a rollback above the last block changes nothing; a rollback below every event empties the network', () => {
    const s = new MetadataState();
    s.apply(ev(2, 3, [record.utf8('name', 'A')]));
    s.rollbackTo('n', 10);
    expect(s.identities()).toHaveLength(1);
    s.rollbackTo('n', 1);
    expect(s.identities()).toHaveLength(0);
  });
});

describe('history (MAY, marked) and tombstones', () => {
  it('keeps replaced values as marked history, never as current; a Null record drops only its own field\'s history', () => {
    const s = new MetadataState({ keepHistory: true });
    s.apply(ev(1, 3, [record.utf8('name', 'Alpha'), record.utf8('symbol', 'ALP')]));
    s.apply(ev(2, 3, [record.utf8('name', 'Beta'), record.utf8('symbol', 'BET')]));
    const id = s.identity('n', A, D, 3)!;
    expect(id.common).toEqual({ name: 'Beta', symbol: 'BET' });
    const h = s.history(id.key, NAME);
    expect(h.map((x) => new TextDecoder().decode(x.value))).toEqual(['Alpha']);
    expect(h[0]!.replacedAt.block).toBe(2n);
    s.apply(ev(3, 3, [record.tombstone('name')]));
    expect(s.history(id.key, NAME)).toEqual([]);
    expect(s.history(id.key, SYMBOL).map((x) => new TextDecoder().decode(x.value))).toEqual(['ALP']);
    expect(s.identity('n', A, D, 3)!.common).toEqual({ symbol: 'BET' });
    // A later value for the deleted key starts a new history: nothing from before the Null returns.
    s.apply(ev(4, 3, [record.utf8('name', 'Gamma')]));
    s.apply(ev(5, 3, [record.utf8('name', 'Delta')]));
    expect(s.history(id.key, NAME).map((x) => new TextDecoder().decode(x.value))).toEqual(['Gamma']);
  });
  it('when the last field is deleted, the identity goes with all its history; a revival has only the new field', () => {
    const s = new MetadataState({ keepHistory: true });
    s.apply(ev(1, 3, [record.utf8('name', 'Alpha'), record.utf8('symbol', 'ALP')]));
    s.apply(ev(2, 3, [record.utf8('name', 'Beta'), record.utf8('symbol', 'BET')]));
    const key = s.identity('n', A, D, 3)!.key;
    s.apply(ev(3, 3, [record.tombstone('name'), record.tombstone('symbol')]));
    expect(s.identity('n', A, D, 3)).toBeUndefined();
    expect(s.identities()).toEqual([]);
    expect(s.history(key, NAME)).toEqual([]);
    expect(s.history(key, SYMBOL)).toEqual([]);
    s.apply(ev(4, 3, [record.utf8('symbol', 'NEW')]));
    expect(s.identity('n', A, D, 3)!.fields.map((f) => f.keyHex)).toEqual([SYMBOL]);
    expect(s.history(key, NAME)).toEqual([]);
    expect(s.history(key, SYMBOL)).toEqual([]);
  });
});

describe('per-key tombstones (MIP "Applying records")', () => {
  const four = () => commonRecords({ name: 'Gold', symbol: 'GLD', decimals: 6, standards: 'mip-0004' });
  it('a Null record deletes only its own field', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [...four()]));
    expect(s.apply(ev(2, 3, [record.tombstone('name')]))).toMatchObject({ result: 'accept', records: 1 });
    const id = s.identity('n', A, D, 3)!;
    expect(id.common).toEqual({ symbol: 'GLD', decimals: 6n, standards: ['mip-0004'] });
    expect(id.fields.map((f) => f.keyHex)).toEqual([SYMBOL, DECIMALS, STANDARDS]);
  });
  it('a Null record for a field without a value has no effect (a second Null, or a key never set)', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [...four()]));
    s.apply(ev(2, 3, [record.tombstone('name')]));
    const before = s.identities();
    s.apply(ev(3, 3, [record.tombstone('name')]));
    s.apply(ev(4, 3, [record.tombstone('retire')]));
    expect(s.identities()).toEqual(before);
  });
  it('Null records alone never create an identity (nothing in listings, lookups, groups or display)', () => {
    const s = new MetadataState();
    expect(s.apply(ev(1, 1, [record.tombstone('name'), record.tombstone('symbol')]))).toMatchObject({ result: 'accept', records: 2 });
    expect(s.identities()).toEqual([]);
    expect(s.identity('n', A, D, 1)).toBeUndefined();
    expect(s.groups()).toEqual([]);
    expect(s.display(s.identity('n', A, D, 1), 1n)).toEqual({ decimals: null, text: null });
  });
  it('deleting the last field removes the identity from listings, lookups and groups; other identities stay', () => {
    const s = new MetadataState();
    s.apply(ev(1, 1, [...four()], { event: 0 }));
    s.apply(ev(1, 3, [...four()], { event: 1 }));
    expect(s.groups().map((g) => g.members.length)).toEqual([2]);
    s.apply(ev(2, 1, [record.tombstone('name'), record.tombstone('symbol'), record.tombstone('decimals'), record.tombstone('standards')]));
    expect(s.identities().map((v) => v.kind)).toEqual([3]);
    expect(s.identity('n', A, D, 1)).toBeUndefined();
    expect(s.identity('n', A, D, 3)!.common.name).toBe('Gold');
    expect(s.groups().map((g) => g.members.map((m) => m.kind))).toEqual([[3]]);
    // A repeated withdrawal changes nothing and does not bring the identity back.
    s.apply(ev(3, 1, [record.tombstone('name'), record.tombstone('symbol'), record.tombstone('decimals'), record.tombstone('standards')]));
    expect(s.identities().map((v) => v.kind)).toEqual([3]);
  });
  it('a later non-Null record describes the identity again with only that field', () => {
    const s = new MetadataState();
    s.apply(ev(1, 1, [...four()]));
    s.apply(ev(2, 1, [record.tombstone('name'), record.tombstone('symbol'), record.tombstone('decimals'), record.tombstone('standards')]));
    s.apply(ev(3, 1, [record.utf8('name', 'New')]));
    const id = s.identity('n', A, D, 1)!;
    expect(id.fields.map((f) => f.keyHex)).toEqual([NAME]);
    expect(id.common).toEqual({ name: 'New' }); // no standards: the earlier list does not return
  });
  it('deleting a member\'s symbol removes it from its group (S9)', () => {
    const s = new MetadataState();
    s.apply(ev(1, 1, [record.utf8('name', 'One'), record.utf8('symbol', 'ACME')], { event: 0 }));
    s.apply(ev(1, 3, [record.utf8('name', 'Three'), record.utf8('symbol', 'ACME')], { event: 1 }));
    s.apply(ev(2, 3, [record.tombstone('symbol')]));
    expect(s.groups().map((g) => g.members.map((m) => m.kind))).toEqual([[1]]);
    expect(s.identity('n', A, D, 3)!.common).toEqual({ name: 'Three' });
  });
  it('within one event, records apply in order: delete then set, and set then delete', () => {
    const s = new MetadataState();
    s.apply(ev(1, 1, [record.utf8('name', 'A'), record.tombstone('name'), record.utf8('name', 'B')]));
    expect(s.identity('n', A, D, 1)!.common).toEqual({ name: 'B' });
    s.apply(ev(2, 1, [record.utf8('symbol', 'S'), record.tombstone('symbol'), record.tombstone('name')]));
    expect(s.identity('n', A, D, 1)).toBeUndefined();
  });
  it('a reorganization that removes the deleting block restores the deleted fields (S4)', () => {
    const s = new MetadataState();
    s.apply(ev(1, 1, [...four()]));
    s.apply(ev(2, 1, [record.tombstone('name')]));
    s.apply(ev(3, 1, [record.tombstone('symbol'), record.tombstone('decimals'), record.tombstone('standards')]));
    expect(s.identity('n', A, D, 1)).toBeUndefined();
    s.rollbackTo('n', 2);
    expect(s.identity('n', A, D, 1)!.common).toEqual({ symbol: 'GLD', decimals: 6n, standards: ['mip-0004'] });
    s.apply(ev(3, 1, [record.tombstone('symbol'), record.tombstone('decimals'), record.tombstone('standards')]));
    expect(s.identity('n', A, D, 1)).toBeUndefined();
  });
  it('a Null record never falls back to an earlier value of its field', () => {
    const s = new MetadataState({ keepHistory: true });
    s.apply(ev(1, 3, [record.utf8('name', 'Alpha'), record.utf8('symbol', 'ALP')]));
    s.apply(ev(2, 3, [record.utf8('name', 'Beta')]));
    s.apply(ev(3, 3, [record.tombstone('name')]));
    const id = s.identity('n', A, D, 3)!;
    expect(id.common.name).toBeUndefined();
    expect(id.fields.find((f) => f.keyHex === NAME)).toBeUndefined();
  });
});

describe('color hook', () => {
  it('is called for kinds 1 and 2 only, never for kind 3', () => {
    const tokenType = vi.fn((d: Uint8Array, c: Uint8Array) => Uint8Array.from([...d.subarray(0, 16), ...c.subarray(0, 16)]));
    const s = new MetadataState({ tokenType });
    for (const [i, kind] of [1, 2, 3].entries()) s.apply(ev(1, kind, [record.utf8('name', 'X')], { event: i }));
    const views = s.identities();
    expect(views.map((v) => [v.kind, v.colored, v.color === null])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, false, true],
    ]);
    expect(tokenType).toHaveBeenCalledTimes(2);
    for (const call of tokenType.mock.calls) expect(call[1]).toEqual(Uint8Array.from(Buffer.from(A, 'hex')));
  });
  it('without a hook, kinds 1 and 2 are colored but have no color value', () => {
    const s = new MetadataState();
    s.apply(ev(1, 1, [record.utf8('name', 'X')]));
    expect(s.identities()[0]).toMatchObject({ colored: true, color: null });
  });
});

describe('common fields view and display', () => {
  it('exposes only usable values and no defaults', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [...commonRecords({ name: 'Acme', symbol: 'ACME', standards: 'mip-0004 erc-20' })]));
    const id = s.identity('n', A, D, 3)!;
    expect(id.common).toEqual({ name: 'Acme', symbol: 'ACME', standards: ['mip-0004', 'erc-20'] });
    expect(s.display(id, 123456n)).toEqual({ decimals: null, text: null }); // never assume 0 or 18
    s.apply(ev(2, 3, [record.uint('decimals', 2)]));
    expect(s.display(s.identity('n', A, D, 3), 123456n)).toEqual({ decimals: 2n, text: '1234.56' });
    s.apply(ev(3, 3, [record.utf8('decimals', '2')]));
    expect(s.display(s.identity('n', A, D, 3), 123456n)).toEqual({ decimals: null, text: null });
  });
  it('an identity whose decimals was deleted displays nothing (no fallback, no default)', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [record.utf8('name', 'Acme'), record.uint('decimals', 2), record.tombstone('decimals')]));
    expect(s.display(s.identity('n', A, D, 3), 1n)).toEqual({ decimals: null, text: null });
  });
  it('a withdrawn identity (every field deleted) is not found and displays nothing', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [record.uint('decimals', 2)]));
    s.apply(ev(2, 3, [record.tombstone('decimals')]));
    expect(s.identity('n', A, D, 3)).toBeUndefined();
    expect(s.display(s.identity('n', A, D, 3), 1n)).toEqual({ decimals: null, text: null });
  });
});

describe('input validation', () => {
  it('rejects bad positions and addresses with a TypeError', () => {
    const s = new MetadataState();
    expect(() => s.apply(ev(1, 3, [record.utf8('name', 'A')], { tx: -1 }))).toThrow(TypeError);
    expect(() => s.apply(ev(1, 3, [record.utf8('name', 'A')], { contractAddress: 'zz' }))).toThrow(TypeError);
    expect(() => s.apply(ev(1, 3, [record.utf8('name', 'A')], { network: '' }))).toThrow(TypeError);
  });
});
