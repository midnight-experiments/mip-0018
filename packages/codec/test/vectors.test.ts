// Every payload vector (normative and informative), decoded in-process by classifyEvent and compared with the
// runner's comparison rules — including the informative reason codes and offsets.
import { compareDecode } from '@mip0018/vectors/compare';
import { loadVectors } from '@mip0018/vectors/runner';
import { describe, expect, it } from 'vitest';
import { classifyEvent, fromHex, toHex } from '../src/index.ts';

const payloadVectors = loadVectors().filter((v) => v.entry.kind === 'payload');

function respond(ev: { type: string; name_hex: string; payload_hex: string }): Record<string, unknown> {
  const c = classifyEvent({ type: ev.type, name: fromHex(ev.name_hex), payload: fromHex(ev.payload_hex) });
  if (c.result !== 'accept') return { ...c };
  return {
    result: 'accept',
    header: { domainSep: toHex(c.header.domainSep), kind: c.header.kind },
    records: c.records.map((r) => ({ offset: r.offset, key_hex: toHex(r.key), valType: r.valType, value_hex: toHex(r.value), ...(r.integer !== undefined ? { decoded: r.integer.toString() } : {}) })),
    contentEnd: c.contentEnd,
  };
}

describe('codec against the payload vectors', () => {
  it('covers 40 normative and 26 informative payload vectors', () => {
    expect(payloadVectors.filter((v) => v.entry.normative).length).toBe(40);
    expect(payloadVectors.filter((v) => !v.entry.normative).length).toBe(26);
  });
  for (const v of payloadVectors) {
    it(`${v.entry.id} [${v.entry.testId}]${v.entry.normative ? '' : ' (informative)'}`, () => {
      const cmp = compareDecode(v.data.expect as Record<string, unknown>, respond(v.data.event as never));
      expect(cmp.failures).toEqual([]);
      expect(cmp.notes).toEqual([]); // reason codes and offsets also match
    });
  }
});
