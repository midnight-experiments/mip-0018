// SPDX-License-Identifier: Apache-2.0
//
// Event order within a transaction (MIP-0018 @ 78ecbb4, "Applying records"): "Within a transaction, events are in
// the ledger's execution order: the guaranteed part of every intent (in ascending segment id), then each successful
// fallible segment (in ascending segment id); within a part, actions and their operations in order."
//
//   * `index` (mint scanner) and `verify` take the order from the raw transaction (`decodeTransaction` + `applied`):
//     a synthetic multi-intent transaction below shows that order is exactly the MIP's.
//   * `list` orders the events of one transaction by the indexer's event id. `verify` (and so `recheck`) checks, per
//     transaction, that the id order equals the raw ledger order: it matches each indexed event, in id order, with the
//     NEXT applied log op of the contract (a cursor that only moves forward), so an indexer whose ids disagreed with
//     the ledger order would fail `event-<i>-in-raw-tx`. The recorded Stagenet multi-event transactions (C04: three
//     events in one call; C08: two) passed that check, in the order the circuits emit them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractCall } from '@midnightntwrk/ledger-v9';
import { EVENT_NAME, encodePayload, record } from '@mip0018/codec';
import { describe, expect, it } from 'vitest';
import { applied, decodeTransaction } from '../src/raw.ts';
import type { VerifyReport } from '../src/verify.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const ADDRESS = 'cc'.repeat(32);

/** A log op's pushed value: `[version, eventType = Misc (10), name ‖ payload]` with a `label` as the payload's name. */
function logItem(label: string) {
  const payload = encodePayload({ domainSep: new Uint8Array(32).fill(0x11), kind: 3 }, [record.utf8('name', label)]);
  const cell = (b: Uint8Array | number[]) => ({ tag: 'cell', content: { value: [Uint8Array.from(b)], alignment: [] } });
  return { tag: 'array', content: [cell([1]), cell([10]), cell([...EVENT_NAME, ...payload])] };
}

function transcript(labels: string[]) {
  const program: unknown[] = [];
  for (const l of labels) program.push({ push: { value: logItem(l) } }, 'log');
  return { program, effects: { shieldedMints: new Map(), unshieldedMints: new Map() } };
}

/** A `ContractCall` (for `instanceof`) whose fields are plain test data. */
function call(entryPoint: string, guaranteed?: string[], fallible?: string[]): ContractCall<never> {
  const c = Object.create(ContractCall.prototype) as ContractCall<never>;
  Object.defineProperties(c, {
    address: { value: ADDRESS },
    entryPoint: { value: entryPoint },
    guaranteedTranscript: { value: guaranteed && transcript(guaranteed) },
    fallibleTranscript: { value: fallible && transcript(fallible) },
  });
  return c;
}

const labelOf = (payloadHex: string): string => {
  const p = Buffer.from(payloadHex, 'hex');
  const len = p[33 + 1 + 4 + 1]!; // keyLen | "name" | valType | valLen
  return p.subarray(33 + 7, 33 + 7 + len).toString('utf8');
};

describe('event order within a transaction (raw ledger order = the MIP rule)', () => {
  // Two intents, inserted out of order: segment 7 (one call: guaranteed a1 a2, fallible a3) and segment 3 (call b:
  // guaranteed b1, fallible b2; call c: guaranteed c1).
  const tx = {
    serialize: () => new Uint8Array(),
    transactionHash: () => 'ab'.repeat(32),
    identifiers: () => [],
    intents: new Map<number, { actions: unknown[] }>([
      [7, { actions: [call('a', ['a1', 'a2'], ['a3'])] }],
      [3, { actions: [call('b', ['b1'], ['b2']), call('c', ['c1'])] }],
    ]),
  };
  const d = decodeTransaction(tx);

  it('guaranteed part of every intent (ascending segment), then each fallible segment (ascending); actions and ops in order', () => {
    expect(d.segments).toEqual([3, 7]);
    expect(d.logs.map((l) => labelOf(l.payload!))).toEqual(['b1', 'c1', 'a1', 'a2', 'b2', 'a3']);
    expect(d.logs.map((l) => `${l.phase}/${l.segment}/${l.actionIndex}/${l.opIndex}`)).toEqual([
      'guaranteed/3/0/1',
      'guaranteed/3/1/1',
      'guaranteed/7/0/1',
      'guaranteed/7/0/3',
      'fallible/3/0/1',
      'fallible/7/0/1',
    ]);
  });

  it('only successful fallible segments count; guaranteed parts unless the transaction failed', () => {
    const partial = applied(d, {
      status: 'PARTIAL_SUCCESS',
      segments: [
        { id: 3, success: false },
        { id: 7, success: true },
      ],
    });
    expect(partial.logs.map((l) => labelOf(l.payload!))).toEqual(['b1', 'c1', 'a1', 'a2', 'a3']);
    const ok = applied(d, { status: 'SUCCESS', segments: null });
    expect(ok.logs.map((l) => labelOf(l.payload!))).toEqual(['b1', 'c1', 'a1', 'a2', 'b2', 'a3']);
    expect(applied(d, { status: 'FAILURE', segments: null }).logs).toEqual([]);
  });
});

describe('recorded Stagenet multi-event transactions: indexer id order = ledger order', () => {
  const observed = (id: string, file: string) =>
    JSON.parse(readFileSync(join(REPO, 'deployments', 'stagenet', 'cases', id, file), 'utf8')) as VerifyReport;
  const idOrderMatchesLedger = (r: VerifyReport) => {
    const ids = r.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b)); // the report lists events in id order
    for (const e of r.events) expect(r.checks.find((c) => c.id === `event-${e.index}-in-raw-tx`)?.ok).toBe(true);
    expect(r.checks.find((c) => c.id === 'completeness')?.ok).toBe(true);
  };

  it('C04: three events of one publishMetadata call, in the order the circuit emits them (kinds 1, 2, 3)', () => {
    const r = observed('C04', 'observed-verify-publish.json');
    expect(r.outcome).toBe('ok');
    idOrderMatchesLedger(r);
    const source = readFileSync(join(REPO, 'examples/openzeppelin/multi-kind/contracts/MyMultiKindToken.compact'), 'utf8');
    const body = source.slice(
      source.indexOf('export circuit publishMetadata'),
      source.indexOf('\n}\n', source.indexOf('export circuit publishMetadata')),
    );
    const KIND: Record<string, number> = { SHIELDED: 1, UNSHIELDED: 2, LEDGER: 3 };
    const emitted = [...body.matchAll(/Mip0018_KIND_(SHIELDED|UNSHIELDED|LEDGER)\(\)/gu)].map((m) => KIND[m[1]!]);
    expect(emitted).toEqual([1, 2, 3]);
    expect(r.events.map((e) => e.classification.kind)).toEqual(emitted);
    expect(new Set(r.events.map((e) => `${e.source?.logicalSegment}/${e.source?.physicalSegment}`)).size).toBe(1); // one part
  });

  it('C08: emitTwo(valid, malformed) — the valid event first, as emitted', () => {
    const r = observed('C08', 'observed-verify-emit-two.json');
    expect(r.outcome).toBe('ok');
    idOrderMatchesLedger(r);
    const expectFile = JSON.parse(readFileSync(join(REPO, 'deployments/stagenet/cases/C08/expect/emit-two.json'), 'utf8')) as Array<{
      result: string;
      payload: string;
    }>;
    expect(r.events.map((e) => e.classification.result)).toEqual(['accept', 'reject']);
    expect(r.events.map((e) => e.payload)).toEqual(expectFile.map((x) => x.payload));
  });
});
