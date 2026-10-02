// SPDX-License-Identifier: Apache-2.0
//
// The zero-padding pitfall: MIP-0018 compares keys and values as exact bytes, so a value carried in a
// `Bytes<K>` wider than the text ("AGL" in `Bytes<4>` = "AGL\0") is a different value. In these
// examples every literal goes through the module's typed builders, whose sizes the compiler checks
// (a shorter literal does not compile), and every step of every example is decoded and compared value
// by value with metadata.json (`expectExactRecords`, used by `expectStepEvents`). This file shows the
// check is not vacuous, and that runtime arguments are where padding can still slip in.
import { commonRecords, decodePayload, decodeUtf8, encodePayload, fromHex, record, toHex } from '@mip0018/codec';
import { describe, expect, it } from 'vitest';
import { compileExample } from '../src/examples.ts';
import { expectExactRecords } from '../src/expect.ts';
import { account, accountId, callAs, deployAs, exampleAddress, loadMetadata, utf8, type ExpectedEvent } from '../src/testing.ts';

const META = loadMetadata('fungible-token');
const PUBLISHED = META.steps[0]!.events[0]!;
const header = { domainSep: fromHex(PUBLISHED.domainSep), kind: PUBLISHED.kind };

describe('exact values (no zero padding)', () => {
  it('accepts the published payload of metadata.json', () => {
    expect(() => expectExactRecords(fromHex(PUBLISHED.payload), PUBLISHED, 'publish')).not.toThrow();
  });

  it('rejects a payload whose symbol carries a padding byte ("AGLD" sent as "AGLD\\0")', () => {
    const padded = encodePayload(header, [
      record.utf8('name', 'Acme Gold'),
      { key: utf8('symbol'), valType: 1, value: Uint8Array.of(...utf8('AGLD'), 0) },
      record.uint('decimals', 6, 1),
    ]);
    expect(() => expectExactRecords(padded, PUBLISHED, 'padded symbol')).toThrow();
  });

  it('rejects decimals of another width (Uint<128>) and a missing or extra field', () => {
    const wide = encodePayload(header, commonRecords({ name: 'Acme Gold', symbol: 'AGLD' }).concat(record.uint('decimals', 6, 16)));
    expect(() => expectExactRecords(wide, PUBLISHED, 'wide decimals')).toThrow();
    const missing = encodePayload(header, commonRecords({ name: 'Acme Gold', symbol: 'AGLD' }));
    expect(() => expectExactRecords(missing, PUBLISHED, 'missing decimals')).toThrow();
    const extra = encodePayload(header, commonRecords({ name: 'Acme Gold', symbol: 'AGLD', decimals: 6, standards: 'mip-0004' }));
    expect(() => expectExactRecords(extra, PUBLISHED, 'extra standards')).toThrow();
  });

  it('a runtime argument zero-padded to the circuit size is emitted with its zeros (so never pad; the check catches it)', async () => {
    const managed = compileExample('fungible-token');
    const owner = new Uint8Array(32).fill(0x0a);
    const c = META.contract.constructorArgs as { name_: string; symbol_: string; decimals_: number };
    const sim = await deployAs(managed, owner, [c.name_, c.symbol_, BigInt(c.decimals_), account(accountId(owner))], exampleAddress('pad'));
    // A shorter array is refused by the runtime's type check (setMetadata takes exactly 9 + 4 bytes) ...
    await expect(callAs(sim, owner, 'setMetadata', utf8('Short'), utf8('ABCD'))).rejects.toThrow(/expected value of type Bytes<9>/u);
    // ... but a caller who pads "Short" with zeros to 9 bytes publishes "Short\0\0\0\0".
    const padded = new Uint8Array(9);
    padded.set(utf8('Short'));
    const out = await callAs(sim, owner, 'setMetadata', padded, utf8('ABCD'));
    const d = decodePayload(out.misc[0]!.payload);
    if (!d.ok) throw new Error(d.reason);
    expect(toHex(d.records[0]!.value)).toBe(toHex(padded));
    expect(decodeUtf8(d.records[0]!.value)).toBe('Short\0\0\0\0');
    const intended: ExpectedEvent = { ...PUBLISHED, name: 'Short', symbol: 'ABCD', decimals: undefined, payload: '' };
    expect(() => expectExactRecords(out.misc[0]!.payload, intended, 'padded runtime name')).toThrow();
  });
});
