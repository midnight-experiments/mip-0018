// MIP "Consuming": "Some sources drop trailing zero bytes; consumers MUST treat missing trailing bytes as
// zero, so that every `name` is 32 bytes and every `payload` 256 bytes, before decoding." The codec zero-extends a
// short name or payload, ignores a longer name (another name) and rejects a longer payload.
import { describe, expect, it } from 'vitest';
import {
  classifyEvent,
  commonRecords,
  decodePayload,
  encodePayload,
  EVENT_NAME,
  isMip0018Name,
  record,
  splitMiscData,
  toHex,
  zeroExtend,
} from '../src/index.ts';

const A1 = encodePayload(
  { domainSep: new Uint8Array(32).fill(0x11), kind: 3 },
  commonRecords({ name: 'Acme Token', symbol: 'ACME', decimals: 6, standards: ['mip-0004'] }),
);
const trim = (b: Uint8Array): Uint8Array => {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.slice(0, end);
};

describe('zeroExtend', () => {
  it('extends shorter input with zero bytes, returns equal-length input as is, refuses longer input', () => {
    expect([...zeroExtend(Uint8Array.from([1, 2]), 4)!]).toEqual([1, 2, 0, 0]);
    expect(zeroExtend(new Uint8Array(0), 3)).toEqual(new Uint8Array(3));
    const same = Uint8Array.from([1, 2, 3]);
    expect(zeroExtend(same, 3)).toBe(same);
    expect(zeroExtend(new Uint8Array(5), 4)).toBeUndefined();
  });
});

describe('name', () => {
  it('a name without its trailing zero bytes is the v1 name; a longer one is another name', () => {
    expect(trim(EVENT_NAME).length).toBe(27);
    expect(isMip0018Name(trim(EVENT_NAME))).toBe(true);
    expect(isMip0018Name(EVENT_NAME)).toBe(true);
    expect(isMip0018Name(Uint8Array.from([...EVENT_NAME, 0]))).toBe(false);
    expect(isMip0018Name(new Uint8Array(0))).toBe(false);
    expect(isMip0018Name(EVENT_NAME.subarray(0, 26))).toBe(false); // a byte of the text is missing, not a zero
  });
});

describe('classifyEvent', () => {
  const full = classifyEvent({ type: 'Misc', name: EVENT_NAME, payload: A1 });

  it('trimmed name and/or payload: exactly the full form (A1)', () => {
    expect(full.result).toBe('accept');
    for (const ev of [
      { name: trim(EVENT_NAME), payload: A1 },
      { name: EVENT_NAME, payload: trim(A1) },
      { name: trim(EVENT_NAME), payload: trim(A1) },
    ]) {
      expect(trim(A1).length).toBe(95);
      expect(classifyEvent({ type: 'Misc', ...ev })).toEqual(full);
    }
  });

  it('a value whose trailing zero bytes were dropped with the padding gets them back (A3b)', () => {
    const p = encodePayload({ domainSep: new Uint8Array(32).fill(0x11), kind: 3 }, [record.bytes('data', Uint8Array.from([1, 0, 0]))]);
    const t = trim(p);
    expect(t.length).toBe(41);
    const c = classifyEvent({ type: 'Misc', name: EVENT_NAME, payload: t });
    expect(c.result).toBe('accept');
    if (c.result === 'accept') expect(toHex(c.records[0]!.value)).toBe('010000');
  });

  it('a payload longer than 256 bytes is rejected; a name longer than 32 bytes is another name', () => {
    expect(classifyEvent({ type: 'Misc', name: EVENT_NAME, payload: Uint8Array.from([...A1, 0]) })).toEqual({
      result: 'reject',
      reason: 'bad-payload-length',
      offset: 0,
    });
    expect(classifyEvent({ type: 'Misc', name: Uint8Array.from([...EVENT_NAME, 0]), payload: A1 })).toEqual({
      result: 'ignore',
      reason: 'other-name',
    });
  });

  it('an empty payload is 256 zero bytes: kind 0, rejected', () => {
    expect(classifyEvent({ type: 'Misc', name: EVENT_NAME, payload: new Uint8Array(0) })).toEqual({
      result: 'reject',
      reason: 'bad-kind',
      offset: 32,
    });
  });

  it('decodePayload zero-extends too', () => {
    expect(decodePayload(trim(A1))).toEqual(decodePayload(A1));
  });
});

describe('splitMiscData (raw name ‖ payload with trailing zeros dropped)', () => {
  it('a 127-byte raw item (name + A1 content) is the full name and payload', () => {
    const raw = trim(Uint8Array.from([...EVENT_NAME, ...A1]));
    expect(raw.length).toBe(32 + 95);
    const s = splitMiscData(raw)!;
    expect(toHex(s.name)).toBe(toHex(EVENT_NAME));
    expect(toHex(s.payload)).toBe(toHex(A1));
    expect(splitMiscData(new Uint8Array(289))).toBeUndefined();
  });
});
