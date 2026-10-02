// Reducer behaviour beyond the vectors: chain-order assertion, rollback edge cases, marked history, color hook,
// common-field views and display without decimals.
import { encodePayload, EVENT_NAME, record, commonRecords } from '@mip0018/codec';
import { describe, expect, it, vi } from 'vitest';
import { ChainOrderError, MetadataState, type ObservedEvent } from '../src/index.ts';

const D = new Uint8Array(32).fill(0x11);
const A = 'aa'.repeat(32);
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
  it('keeps replaced values as marked history, never as current; a tombstone drops it', () => {
    const s = new MetadataState({ keepHistory: true });
    s.apply(ev(1, 3, [record.utf8('name', 'Alpha')]));
    s.apply(ev(2, 3, [record.utf8('name', 'Beta')]));
    const id = s.identity('n', A, D, 3)!;
    expect(id.common.name).toBe('Beta');
    const h = s.history(id.key, '6e616d65');
    expect(h.map((x) => new TextDecoder().decode(x.value))).toEqual(['Alpha']);
    expect(h[0]!.replacedAt.block).toBe(2n);
    s.apply(ev(3, 3, [record.tombstone()]));
    expect(s.history(id.key, '6e616d65')).toEqual([]);
    s.apply(ev(4, 3, [record.utf8('symbol', 'NEW')]));
    expect(s.identity('n', A, D, 3)!.fields.map((f) => f.keyHex)).toEqual(['73796d626f6c']);
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
  it('a hidden identity displays nothing', () => {
    const s = new MetadataState();
    s.apply(ev(1, 3, [record.uint('decimals', 2), record.tombstone()]));
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
