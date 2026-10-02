// SPDX-License-Identifier: Apache-2.0
//
// Prepares the Stagenet case folders deployments/stagenet/cases/<ID>/ (C01–C10, IDX) BEFORE any transaction:
//
//   case.json        what the case demonstrates, one `mip0018` command per step (placeholders below), the exit code
//                    each must end with, and the "recheck" list behind `mip0018 recheck --case <dir>` (FR-053)
//   expected.json    the consumer state the case must end in — derived from the example's metadata.json payloads
//                    (or the vectors) with the reference reducer `@mip0018/consumer`, and cross-checked against the
//                    example's own `expected` where it has one; never from an observation
//   expect/*.json    per transaction: what `verify` must find (result, reason, exact name and payload per event)
//   args/*.json      circuit arguments too long for a command line (the raw emitter's 288-byte events)
//   README.md        the commands rendered for Stagenet (S5 runs them; values are filled in by S5's records)
//
//   node deployments/stagenet/tools/prepare-cases.ts            (re)write every case folder
//   node deployments/stagenet/tools/prepare-cases.ts --check    exit 1 when a committed file differs (CI)
//
// Placeholders in a step's argv (expanded by whoever runs the case — S5 on Stagenet, the local end-to-end test on
// the local stack): "{net}" / "{signer}" / "{signer2}" are whole arguments that expand to several options; "{case}"
// (this folder), "{out}" (where the records and observations go — this folder on Stagenet) and "{out:<ID>}" (another
// case's output folder) are replaced inside arguments; "{firstHeight}" / "{lastHeight}" (IDX only) are the lowest
// inclusion height of the matrix minus 10 and the highest one, read from the records.
//
// No network access, no wallet: run it anywhere (`docker/run.sh exec 'node deployments/stagenet/tools/prepare-cases.ts'`).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { classifyEvent, commonRecords, encodePayload, fromHex } from '@mip0018/codec';
import { MetadataState } from '@mip0018/consumer';
import { compareState, projectState, tokenType, type ExpectedIdentity, type ExpectedState } from '@mip0018/midnight';
import type { PublishCall } from '@mip0018/midnight/signer';
import {
  callOf as minimalCallOf,
  lifecycleCalls as minimalLifecycle,
  metadataOf as minimalMeta,
} from '../../../examples/minimal/src/adapter.ts';
import { callOf as ozCallOf, metadataOf as ozMeta } from '../../../examples/openzeppelin/src/adapter.ts';
import type { ExampleName } from '../../../examples/openzeppelin/src/examples.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const CASES = join(REPO, 'deployments', 'stagenet', 'cases');
const MIP = { commit: 'b147c627e1bb15b5d15cc73cf30c2a36afd34dbb', eventName: 'mip-0018:token-metadata[v1]' };
const EVENT_NAME_HEX = Buffer.from(MIP.eventName).toString('hex').padEnd(64, '0');
/** Stand-in contract address for deriving expectations (colors are never part of them: they depend on the address). */
const PLACEHOLDER_ADDRESS = 'cc'.repeat(32);

type Expectation = {
  result: 'accept' | 'reject' | 'ignore';
  reason?: string;
  name?: string;
  payload: string;
  domainSep?: string;
  kind?: number;
};
type Step = {
  id: string;
  runner: 'signer' | 'wallet-free';
  wallet?: 'wallet1' | 'wallet2';
  /** A wallet-free repository script run with node instead of a `mip0018` command (argv = its options). */
  script?: string;
  argv: string[];
  expectExit: number;
  /** The transaction this step submits (none when refused or wallet-free). */
  submits?: 'deploy' | 'call' | 'verifier-key-remove' | 'verifier-key-insert+call';
  /** Save stdout here (relative to {out}). */
  stdout?: string;
  /** A failing step must fail for this reason: a text its output (stdout or stderr) contains. */
  expectOutput?: string;
  note?: string;
};
type Recheck = {
  verify?: { record: string; step: string; expect: string }[];
  list?: { record: string; expect: string; atStep?: string }[];
  noTransaction?: { record: string; step: string }[];
  operationsAbsent?: { record: string; circuit: string }[];
  colors?: {
    record: string;
    domainSep: string;
    kind: 1 | 2;
    index?: string;
    wallet?: string;
    minted?: boolean;
    expectIdentity?: ExpectedIdentity;
  }[];
};
type CaseDef = {
  id: string;
  title: string;
  demonstrates: string;
  conclusion: string;
  source: Record<string, string>;
  dependsOn?: string[];
  notes?: string[];
  steps: Step[];
  recheck: Recheck;
  files: Record<string, unknown>;
};

// ------------------------------------------------------------------------------------------------- the reducer

/** Applies events (in order, one transaction per step) with the reference consumer; returns the projected state. */
function reduce(steps: { name: string; payload: string }[][], o: { fields?: boolean; counts?: boolean } = {}): ExpectedState {
  const s = new MetadataState({ tokenType });
  const counts = { events: 0, accepted: 0, rejected: 0, ignored: 0 };
  steps.forEach((evs, block) =>
    evs.forEach((e, event) => {
      const r = s.apply({
        network: 'stagenet',
        contractAddress: fromHex(PLACEHOLDER_ADDRESS),
        block: block + 1,
        tx: 0,
        event,
        type: 'Misc',
        name: fromHex(e.name),
        payload: fromHex(e.payload),
      });
      counts.events++;
      counts[r.result === 'accept' ? 'accepted' : r.result === 'reject' ? 'rejected' : 'ignored']++;
    }),
  );
  const p = projectState(s.identities(), s.groups(), o.counts ? counts : undefined);
  if (!o.fields) for (const i of p.identities) delete i.fields;
  return p;
}

const sameState = (a: ExpectedState, b: ExpectedState, what: string) => {
  const c = compareState(a, b);
  if (!c.ok) throw new Error(`${what}: the reducer disagrees with the example's expected state:\n  ${c.differences.join('\n  ')}`);
};

/** The verify expectation of a call (exact name + payload per event, and the result). */
const expectOf = (c: PublishCall): Expectation[] =>
  (c.expect ?? []).map((e) => {
    if (!e.payload) throw new Error(`${c.stepId}: no exact payload`);
    const cl = classifyEvent({ type: 'Misc', name: fromHex(EVENT_NAME_HEX), payload: fromHex(e.payload) });
    return {
      result: cl.result,
      ...('reason' in cl ? { reason: cl.reason } : {}),
      name: EVENT_NAME_HEX,
      payload: e.payload,
      ...(e.domainSep ? { domainSep: e.domainSep } : {}),
      ...(e.kind ? { kind: e.kind } : {}),
    };
  });
const eventsOf = (c: PublishCall) => expectOf(c).map((e) => ({ name: e.name!, payload: e.payload }));

// ------------------------------------------------------------------------------------------------- step builders

const NET = '{net}';
const S1 = '{signer}';
const S2 = '{signer2}';
const REC = '{out}/record.json';
const sh = (v: unknown) => JSON.stringify(v);

const deploy = (target: string[], note?: string): Step => ({
  id: 'deploy',
  runner: 'signer',
  wallet: 'wallet1',
  argv: ['deploy', NET, S1, ...target, '--record', REC],
  expectExit: 0,
  submits: 'deploy',
  ...(note ? { note } : {}),
});
const call = (c: PublishCall, o: { force?: boolean; note?: string; expectExit?: number } = {}): Step => ({
  id: c.stepId!,
  runner: 'signer',
  wallet: 'wallet1',
  argv: [
    (c.expect ?? []).length > 0 ? 'publish' : 'call',
    NET,
    S1,
    '--record',
    REC,
    '--circuit',
    c.circuit,
    ...(c.args.length ? ['--args', sh(c.args)] : []),
    '--step',
    c.stepId!,
    ...(o.force ? ['--force'] : []),
  ],
  expectExit: o.expectExit ?? 0,
  ...(o.expectExit ? {} : { submits: 'call' as const }),
  ...(o.note ? { note: o.note } : {}),
});
const verify = (step: string): Step => ({
  id: `verify-${step}`,
  runner: 'wallet-free',
  argv: ['verify', NET, '--record', REC, '--step', step, '--expect', `@{case}/expect/${step}.json`, '--wait', '120'],
  expectExit: 0,
});
const list = (expectFile = 'expected.json', id = 'list', record = REC): Step => ({
  id,
  runner: 'wallet-free',
  argv: ['list', NET, '--record', record, '--expect', `@{case}/${expectFile}`, '--json'],
  expectExit: 0,
  stdout: id === 'list' ? 'observed-list.json' : `observed-${id}.json`,
});
const walletStatus = (): Step => ({
  id: 'wallet-status',
  runner: 'signer',
  wallet: 'wallet1',
  argv: ['wallet', 'status', NET, S1, '--json'],
  expectExit: 0,
  stdout: 'wallet-status.json',
  note: "wallet 1's balances per token type: the minted coin/UTXO color as the wallet SDK sees it (independent of our tokenType code)",
});

// ------------------------------------------------------------------------------------------------- the cases

function ozCase(
  id: string,
  example: ExampleName,
  title: string,
  demonstrates: string,
  conclusion: string,
  o: { wallet?: boolean; notes?: string[] } = {},
): { def: CaseDef; expected: ExpectedState } {
  const meta = ozMeta(example);
  const calls = meta.steps.map((s) => ozCallOf(s, `${example}.${s.id}`));
  const expected = reduce(calls.filter((c) => (c.expect ?? []).length > 0).map(eventsOf));
  sameState(expected, meta.expected, `${id} (${example})`);
  const files: Record<string, unknown> = { 'expected.json': expected };
  const steps: Step[] = [deploy(['--example', example])];
  const verifies: Recheck['verify'] = [];
  for (const c of calls) {
    steps.push(call(c));
    if ((c.expect ?? []).length > 0) {
      files[`expect/${c.stepId}.json`] = expectOf(c);
      verifies.push({ record: 'record.json', step: c.stepId!, expect: `expect/${c.stepId}.json` });
    }
  }
  for (const v of verifies) steps.push(verify(v.step));
  steps.push(list());
  const colors: Recheck['colors'] = [];
  if (o.wallet) {
    steps.push(walletStatus());
    for (const s of meta.steps)
      for (const m of (s as { mints?: { kind: 1 | 2; domainSep: string }[] }).mints ?? [])
        colors.push({
          record: 'record.json',
          domainSep: m.domainSep,
          kind: m.kind,
          wallet: 'wallet-status.json',
          expectIdentity: expected.identities.find((i) => i.domainSep === m.domainSep && i.kind === m.kind)!,
        });
  }
  return {
    def: {
      id,
      title,
      demonstrates,
      conclusion,
      source: { example: `examples/openzeppelin/${example}`, metadata: `examples/openzeppelin/${example}/metadata.json` },
      ...(o.notes ? { notes: o.notes } : {}),
      steps,
      recheck: { verify: verifies, list: [{ record: 'record.json', expect: 'expected.json' }], ...(colors.length ? { colors } : {}) },
      files,
    },
    expected,
  };
}

const vector = (id: string) =>
  JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', `${id}.json`), 'utf8')) as {
    event: { name_hex: string; payload_hex: string };
    expect: { result: 'accept' | 'reject' | 'ignore'; reason?: string };
  };

function build(): { cases: CaseDef[] } {
  const cases: CaseDef[] = [];
  const expectedOf: Record<string, ExpectedState> = {};

  const c01 = ozCase(
    'C01',
    'fungible-token',
    'OpenZeppelin FungibleToken (kind 3): deploy, publish',
    'The common fields in one event from an OpenZeppelin token; kind 3 has no color.',
    '1 visible kind-3 identity with 3 usable fields (name "Acme Gold", symbol "AGLD", decimals 6); no standards (Q25); no color.',
    {
      notes: [
        'Q25: the OpenZeppelin examples publish no `standards`; the A1 shape (with standards) on Stagenet is C06/C10 (examples/minimal).',
      ],
    },
  );
  const c02 = ozCase(
    'C02',
    'native-shielded',
    'OpenZeppelin NativeShieldedToken (kind 1): deploy, mint, publish',
    'color = tokenType(domainSep, contract) = the color of the shielded coin minted to wallet 1.',
    '1 visible kind-1 identity ("Acme Shield", "ASHD", 6) with a color equal to the minted coin color.',
    { wallet: true },
  );
  const c03 = ozCase(
    'C03',
    'native-unshielded',
    'Native unshielded token (kind 2; std-lib mintUnshieldedToken + OpenZeppelin Ownable): deploy, mint to wallet 1, publish',
    "color = wallet 1's UTXO token type; IDX resolves that color back to the identity.",
    '1 visible kind-2 identity ("Acme Public", "APUB", 6) whose color is the token type of the UTXO wallet 1 received.',
    { wallet: true },
  );
  const c04 = ozCase(
    'C04',
    'multi-kind',
    'One asset in kinds 1, 2, 3 (OpenZeppelin NativeShieldedToken + FungibleToken, std-lib unshielded): deploy, three mints, publish',
    'Symbol grouping on chain (vector S9): three identities under one domainSep and symbol form one group; kinds 1 and 2 share one color.',
    '3 visible identities ("Acme Dollar", "ACD", 2) in ONE group "ACD"; kinds 1 and 2 colored (same color), kind 3 not.',
    {
      wallet: true,
      notes: ['S3 delta: the three identities are published by ONE publishMetadata() transaction with three events (not "publish ×3").'],
    },
  );
  const c05 = ozCase(
    'C05',
    'token-family',
    'OpenZeppelin NativeShieldedTokenFamily: deploy, mint gold + silver, publish three domains',
    'Separate identities per domainSep (vector S6) in one contract.',
    '3 visible kind-1 identities ("Acme Medals", "MEDAL", 0), one per domain, in one group "MEDAL"; three distinct colors.',
    {
      wallet: true,
      notes: ['S3 delta: publishMetadata(domain) is called three times (three transactions); bronze is published but never minted.'],
    },
  );
  for (const c of [c01, c02, c03, c04, c05]) {
    cases.push(c.def);
    expectedOf[c.def.id] = c.expected;
  }

  // C06 — minimal OwnerKey lifecycle
  {
    const meta = minimalMeta('OwnerKey');
    const publish = { ...minimalCallOf(meta.steps[0]!) };
    const life = minimalLifecycle('OwnerKey');
    const files: Record<string, unknown> = {};
    const steps: Step[] = [deploy(['--adapter', 'examples/minimal/owner-key.mip0018.adapter.ts'])];
    const evs: { name: string; payload: string }[][] = [];
    const verifies: Recheck['verify'] = [];
    const lists: Recheck['list'] = [];
    for (const [i, c] of [publish, ...life].entries()) {
      const force = c.stepId === 'withdraw-again';
      steps.push(
        call(c, {
          force,
          ...(force
            ? { note: 'a repeated tombstone changes nothing, so the before-check would skip it: --force emits it anyway (vector S3b)' }
            : {}),
        }),
      );
      evs.push(eventsOf(c));
      const state = reduce(evs);
      const want = i === 0 ? meta.expected : meta.lifecycle[i - 1]!.expected!;
      sameState(state, want, `C06 after ${c.stepId}`);
      files[`expect/${c.stepId}.json`] = expectOf(c);
      files[`expected-after-${c.stepId}.json`] = state;
      steps.push(verify(c.stepId!));
      steps.push(list(`expected-after-${c.stepId}.json`, `list-after-${c.stepId}`));
      verifies.push({ record: 'record.json', step: c.stepId!, expect: `expect/${c.stepId}.json` });
      lists.push({ record: 'record.json', expect: `expected-after-${c.stepId}.json`, atStep: c.stepId! });
    }
    const final = reduce(evs);
    files['expected.json'] = final;
    lists.push({ record: 'record.json', expect: 'expected.json' });
    expectedOf.C06 = final;
    cases.push({
      id: 'C06',
      title: 'Minimal OwnerKey (kind 3, no OpenZeppelin) lifecycle: deploy, publish, rename, tombstone, tombstone again, revive',
      demonstrates:
        'MIP "Updates" on chain: latest value wins (S2), identity-wide tombstone and a repeated one (S3a/S3b), a partial revive brings back nothing from before the tombstone (S3c).',
      conclusion:
        'final: visible with ONLY name "Acme Again" and symbol "ACMA" (decimals and standards cleared by the tombstone do not return); the A1 publish payload equals MIP Appendix A byte-for-byte.',
      source: {
        example: 'examples/minimal',
        contract: 'examples/minimal/contracts/OwnerKey.compact',
        metadata: 'examples/minimal/owner-key.metadata.json',
      },
      notes: [
        'Case-table delta: the S5 table says "only name = New"; OwnerKey renames with setMetadata(name, symbol), so the revive sets name and symbol (10- and 4-byte values: "Acme Again"/"ACMA") — the point of S3c (nothing from before the tombstone returns) is the same.',
        "Every intermediate state is re-checkable: `recheck` lists the contract as of each step's block (`list --to-block`).",
      ],
      steps,
      recheck: { verify: verifies, list: lists },
      files,
    });
  }

  // C07 — raw emitter: capacity, accepted edge cases, malformed, foreign names
  {
    const ids = [
      'A2a',
      'R1',
      'A2b',
      'R2a',
      'A3a',
      'R3a',
      'A3b',
      'R3b',
      'A3c',
      'R4a',
      'A4b',
      'R5a',
      'A5a',
      'R5e',
      'A5b',
      'R5h',
      'A5c',
      'R6b',
      'I1a',
      'I1b',
      'I2a',
      'I2b',
    ];
    const files: Record<string, unknown> = {};
    const steps: Step[] = [deploy(['--example', 'raw-emitter'], 'TEST-ONLY contract (NOT FOR PRODUCTION): owner-gated emitRaw / emitTwo')];
    const evs: { name: string; payload: string }[][] = [];
    const verifies: Recheck['verify'] = [];
    for (const id of ids) {
      const v = vector(id);
      const cl = classifyEvent({ type: 'Misc', name: fromHex(v.event.name_hex), payload: fromHex(v.event.payload_hex) });
      if (cl.result !== v.expect.result || ('reason' in cl ? cl.reason : undefined) !== v.expect.reason)
        throw new Error(`C07: the codec classifies ${id} as ${cl.result}, the vector says ${v.expect.result}`);
      files[`args/${id}.json`] = [v.event.name_hex, v.event.payload_hex];
      files[`expect/${id}.json`] = [
        {
          result: v.expect.result,
          ...(v.expect.reason ? { reason: v.expect.reason } : {}),
          name: v.event.name_hex,
          payload: v.event.payload_hex,
        },
      ];
      steps.push({
        id,
        runner: 'signer',
        wallet: 'wallet1',
        argv: ['publish', NET, S1, '--record', REC, '--circuit', 'emitRaw', '--args', `@{case}/args/${id}.json`, '--step', id, '--force'],
        expectExit: 0,
        submits: 'call',
        note: `vector ${id}: ${v.expect.result}${v.expect.reason ? ` (${v.expect.reason})` : ''}`,
      });
      evs.push([{ name: v.event.name_hex, payload: v.event.payload_hex }]);
      verifies.push({ record: 'record.json', step: id, expect: `expect/${id}.json` });
    }
    for (const v of verifies) steps.push(verify(v.step));
    steps.push(list());
    const expected = reduce(evs, { fields: true, counts: true });
    files['expected.json'] = expected;
    expectedOf.C07 = expected;
    cases.push({
      id: 'C07',
      title:
        'Raw emitter (test-only): capacity, exact-bytes and non-tombstone edge cases accepted; malformed payloads rejected; other names ignored',
      demonstrates:
        "A2a/A2b capacity, A3a–c exact bytes, A4b Uint<128> decimals, A5a–c non-tombstones accepted; R1, R2a, R3a, R3b, R4a, R5a, R5e, R5h, R6b rejected whole; I1a/I1b ([v2]) and I2a/I2b (other names) ignored — each verified with its reason, and the contract's state is exactly what the accepted ones set.",
      conclusion: `${ids.filter((i) => i.startsWith('A')).length} accepted, ${ids.filter((i) => i.startsWith('R')).length} rejected, ${ids.filter((i) => i.startsWith('I')).length} ignored events; one identity (0x11…/3) with exactly the accepted records' fields (expected.json lists every field).`,
      source: { contract: 'test-contracts/raw-emitter', vectors: 'vectors/payload' },
      notes: [
        '--force: accepted vectors are emitted even when they would not change the state; rejected and ignored ones are never skipped (Q27).',
      ],
      steps,
      recheck: { verify: verifies, list: [{ record: 'record.json', expect: 'expected.json' }] },
      files,
    });
  }

  // C08 — two events in one transaction, the second malformed (S7)
  {
    const s7 = JSON.parse(readFileSync(join(REPO, 'vectors', 'state', 'S7b.json'), 'utf8')) as {
      steps: { name_hex: string; payload_hex: string }[];
    };
    const args = s7.steps.flatMap((s) => [s.name_hex, s.payload_hex]);
    const ex: Expectation[] = s7.steps.map((s) => {
      const cl = classifyEvent({ type: 'Misc', name: fromHex(s.name_hex), payload: fromHex(s.payload_hex) });
      return { result: cl.result, ...('reason' in cl ? { reason: cl.reason } : {}), name: s.name_hex, payload: s.payload_hex };
    });
    if (ex[0]!.result !== 'accept' || ex[1]!.result !== 'reject') throw new Error('C08: S7b is not (valid, malformed)');
    const expected = reduce([s7.steps.map((s) => ({ name: s.name_hex, payload: s.payload_hex }))], { fields: true, counts: true });
    expectedOf.C08 = expected;
    cases.push({
      id: 'C08',
      title: 'Raw emitter (test-only): emitTwo(valid, malformed) in one transaction',
      demonstrates:
        'Independent events (vector S7b): event 0 sets name = "Good" and applies; event 1 is malformed (valType 6) and is rejected whole without undoing event 0.',
      conclusion: 'One visible identity (0x11…/3) with only name = "Good"; 2 events: 1 accepted, 1 rejected (reserved-valtype).',
      source: { contract: 'test-contracts/raw-emitter', vector: 'vectors/state/S7b.json' },
      notes: ['A fresh raw-emitter deployment, so the state is S7b alone (independent of C07).'],
      steps: [
        deploy(['--example', 'raw-emitter']),
        {
          id: 'emit-two',
          runner: 'signer',
          wallet: 'wallet1',
          argv: [
            'publish',
            NET,
            S1,
            '--record',
            REC,
            '--circuit',
            'emitTwo',
            '--args',
            '@{case}/args/S7b.json',
            '--step',
            'emit-two',
            '--force',
          ],
          expectExit: 0,
          submits: 'call',
        },
        verify('emit-two'),
        list(),
      ],
      recheck: {
        verify: [{ record: 'record.json', step: 'emit-two', expect: 'expect/emit-two.json' }],
        list: [{ record: 'record.json', expect: 'expected.json' }],
      },
      files: { 'args/S7b.json': args, 'expect/emit-two.json': ex, 'expected.json': expected },
    });
  }

  // C09 — access control: wallet 2 calls the owner-only setMetadata of C01's contract
  cases.push({
    id: 'C09',
    title: "Access control: wallet 2 calls C01's owner-only setMetadata",
    demonstrates:
      'OpenZeppelin Ownable guards the metadata circuits: a non-owner cannot rename the token; the call fails while the transaction is being built, so nothing is submitted or paid.',
    conclusion:
      "the publish command exits 1 (refused before submission: 'Ownable: caller is not the owner'); the record step has no transaction; C01's contract still lists exactly C01's expected state.",
    source: { example: 'examples/openzeppelin/fungible-token', contractOf: 'C01' },
    dependsOn: ['C01'],
    notes: [
      "wallet 2 signs with its OWN private-state file: OpenZeppelin Ownable checks the caller's secret (witness), not the wallet; with wallet 1's private-state file it would be the owner.",
      "`--attach @{out:C01}/record.json` starts this case's own record for C01's contract (C01's record is not touched).",
    ],
    steps: [
      {
        id: 'non-owner-set-metadata',
        runner: 'signer',
        wallet: 'wallet2',
        argv: [
          'publish',
          NET,
          S2,
          '--example',
          'fungible-token',
          '--attach',
          '@{out:C01}/record.json',
          '--record',
          REC,
          '--circuit',
          'setMetadata',
          '--args',
          sh([{ $utf8: 'Evil Gold' }, { $utf8: 'EVIL' }]),
          '--step',
          'non-owner-set-metadata',
        ],
        expectExit: 1,
        expectOutput: 'caller is not the owner',
        note: 'expected to fail before submission (exit 1); the record keeps the attempt (state pending, no transaction)',
      },
      list('expected.json', 'list', '{out:C01}/record.json'),
    ],
    recheck: {
      noTransaction: [{ record: 'record.json', step: 'non-owner-set-metadata' }],
      list: [{ record: '../C01/record.json', expect: 'expected.json' }],
    },
    files: { 'expected.json': expectedOf.C01 },
  });

  // C10 — minimal create-and-destroy
  {
    const meta = minimalMeta('CreateAndDestroy');
    const publish = minimalCallOf(meta.steps[0]!);
    const expected = reduce([eventsOf(publish)]);
    sameState(expected, meta.expected, 'C10');
    expectedOf.C10 = expected;
    cases.push({
      id: 'C10',
      title: 'Minimal create-and-destroy (kind 3, Q4): deploy, publish, VerifierKeyRemove of publishMetadata, publish again',
      demonstrates:
        'The unguarded constant publishMetadata() exists only until its verifier key is removed by the deployer (maintenance authority); afterwards it cannot be called at all.',
      conclusion:
        'one event (= MIP Appendix A, A1, byte-for-byte); the key is gone; the second publish is refused before submission; list shows the A1 metadata.',
      source: {
        example: 'examples/minimal',
        contract: 'examples/minimal/contracts/CreateAndDestroy.compact',
        metadata: 'examples/minimal/metadata.json',
      },
      steps: [
        deploy(['--example', 'minimal']),
        call(publish),
        verify('publish'),
        {
          id: 'remove-key',
          runner: 'signer',
          wallet: 'wallet1',
          argv: ['remove-circuit', NET, S1, '--record', REC, '--circuit', 'publishMetadata'],
          expectExit: 0,
          submits: 'verifier-key-remove',
          note: 'maintenance VerifierKeyRemove in the v4 slot (ZKIR v3 keys, Q23), signed with the maintenance key kept in the 0600 private-state file',
        },
        {
          ...call({ ...publish, stepId: 'publish-again' }, { force: true, expectExit: 1 }),
          expectOutput: 'has no verifier key',
          note: 'refused before submission: publishMetadata has no verifier key any more (exit 1, no transaction)',
        },
        list(),
      ],
      recheck: {
        verify: [{ record: 'record.json', step: 'publish', expect: 'expect/publish.json' }],
        list: [{ record: 'record.json', expect: 'expected.json' }],
        operationsAbsent: [{ record: 'record.json', circuit: 'publishMetadata' }],
        noTransaction: [{ record: 'record.json', step: 'publish-again' }],
      },
      files: { 'expect/publish.json': expectOf(publish), 'expected.json': expected },
    });
  }

  // IDX — the mint scanner over the matrix, then every minted color looked up
  {
    const colors: NonNullable<Recheck['colors']> = [];
    const steps: Step[] = [
      {
        id: 'index',
        runner: 'wallet-free',
        argv: ['index', NET, '--from-height', '{firstHeight}', '--to-height', '{lastHeight}', '--state', '{out}/index', '--json'],
        expectExit: 0,
        stdout: 'index-summary.json',
        note: '{firstHeight} = the lowest inclusion height of the matrix records − 10; {lastHeight} = the highest (S5 fills both)',
      },
    ];
    const add = (caseId: string, domainSep: string, kind: 1 | 2, minted: boolean, label: string) => {
      const id = expectedOf[caseId]!.identities.find((i) => i.domainSep === domainSep && i.kind === kind)!;
      colors.push({ record: `../${caseId}/record.json`, domainSep, kind, index: 'index', minted, expectIdentity: id });
      steps.push({
        id: `lookup-${label}`,
        runner: 'wallet-free',
        argv: [
          'lookup',
          NET,
          '--record',
          `{out:${caseId}}/record.json`,
          '--domain-sep',
          domainSep,
          '--kind',
          String(kind),
          '--state',
          '{out}/index',
          '--json',
        ],
        expectExit: minted ? 0 : 3,
        stdout: `lookup-${label}.json`,
        ...(minted ? {} : { expectOutput: '"found": false' }),
        ...(minted ? {} : { note: 'published but never minted: "not minted in the scanned range" (exit 3)' }),
      });
    };
    const ds = (ex: ExampleName, i = 0) => ozMeta(ex).identities[i]!.domainSep;
    add('C02', ds('native-shielded'), 1, true, 'C02-shielded');
    add('C03', ds('native-unshielded'), 2, true, 'C03-unshielded');
    add('C04', ds('multi-kind'), 1, true, 'C04-shielded');
    add('C04', ds('multi-kind'), 2, true, 'C04-unshielded');
    add('C05', ds('token-family', 0), 1, true, 'C05-gold');
    add('C05', ds('token-family', 1), 1, true, 'C05-silver');
    add('C05', ds('token-family', 2), 1, false, 'C05-bronze');
    cases.push({
      id: 'IDX',
      title: 'Mint scanner over the matrix, then every color looked up (wallet-free)',
      demonstrates:
        'MIP "Lookup" / owner decision F8: from a start height, every native mint of C02–C05 is found once with its (contract, domainSep, kind), and each color resolves to its identity and current metadata.',
      conclusion:
        '6 minted colors (C02 shielded, C03 unshielded, C04 shielded + unshielded = one color, C05 gold, silver) resolve to their contract, domainSep and kind with the metadata of each case; C05 bronze (never minted) is "not minted in the scanned range".',
      source: { tool: 'mip0018 index / lookup' },
      dependsOn: ['C02', 'C03', 'C04', 'C05'],
      notes: [
        "U1 (S6b, the upgrade case, run after the matrix) scans its own block range and looks up its color in its own folder (cases/U1: steps index and lookup), so this scan stays the matrix's range.",
        'The index state lands in {out}/index/index-state.json (deployments/stagenet/cases/IDX/index/ on Stagenet).',
      ],
      steps,
      recheck: { colors },
      files: {
        'expected.json': {
          colors: colors.map(({ record, domainSep, kind, minted, expectIdentity }) => ({
            case: record.split('/')[1],
            domainSep,
            kind,
            minted,
            identity: expectIdentity,
          })),
        },
      },
    });
  }

  // U1 — existing-contract upgrade (S6b): LegacyToken deployed WITHOUT an emitting circuit, a mint, then
  // VerifierKeyInsert(publishMetadata) by the maintenance authority and the call (examples/upgrade-existing-contract)
  {
    const ds = `0x${Buffer.from(U1_DOMAIN).toString('hex').padEnd(64, '0')}`;
    const payload = Buffer.from(
      encodePayload({ domainSep: fromHex(ds), kind: 1 }, commonRecords({ name: 'Legacy Token', symbol: 'LGCY', decimals: 6 })),
    ).toString('hex');
    const cl = classifyEvent({ type: 'Misc', name: fromHex(EVENT_NAME_HEX), payload: fromHex(payload) });
    const publishExpect: Expectation[] = [
      { result: cl.result, ...('reason' in cl ? { reason: cl.reason } : {}), name: EVENT_NAME_HEX, payload, domainSep: ds, kind: 1 },
    ];
    const expected = reduce([[{ name: EVENT_NAME_HEX, payload }]]);
    const identity = expected.identities[0]!;
    const EX = 'examples/upgrade-existing-contract';
    const UP = ['--record', REC, '--source', `${EX}/upgrade`, '--circuit', 'publishMetadata'];
    const inspect = (id: string, note: string): Step => ({
      id,
      runner: 'wallet-free',
      script: `${EX}/scripts/inspect.ts`,
      argv: [
        '--network',
        'stagenet',
        '--record',
        REC,
        '--ledger',
        `${EX}/managed/LegacyToken`,
        '--ledger',
        `${EX}/managed/LegacyTokenMetadata`,
      ],
      expectExit: 0,
      stdout: `observed-${id}.json`,
      note,
    });
    cases.push({
      id: 'U1',
      title:
        'Existing-contract upgrade (S6): deploy a token without an emitting circuit, mint, VerifierKeyInsert(publishMetadata), publish',
      demonstrates:
        'MIP "Existing contracts": a maintenance VerifierKeyInsert adds publishMetadata() to a deployed kind-1 token; the event is bound to the ORIGINAL address, so the color of the coins minted before the upgrade is the identity\'s color; address, domainSep, coins and the other circuit stay as they were. A key outside the maintenance committee is refused.',
      conclusion:
        'same contract address before/after; entry points {mint} → {mint, publishMetadata} with the mint key unchanged; ledger data unchanged; 1 visible kind-1 identity ("Legacy Token", "LGCY", 6) whose color = the color of the coins wallet 1 received from the pre-upgrade mint; the scanner finds that mint before the insert and lookup resolves the color to the new metadata; the insert signed by another key is refused before submission and, forced, rejected by the node.',
      source: {
        example: EX,
        deployed: `${EX}/legacy/LegacyToken.compact`,
        upgrade: `${EX}/upgrade/LegacyTokenMetadata.compact`,
        guide: 'docs/upgrade-guide.md',
      },
      notes: [
        `domainSep = pad(32, "${U1_DOMAIN}") (a LegacyToken constructor argument; publishMetadata() reads it from the ledger).`,
        "The wrong-signer key is a throwaway ledger sampleSigningKey() in the signer state directory (0600) — never wallet material; it is not in the contract's one-key committee.",
        'On Stagenet only the free negatives run (owner plan S6b): the refused insert (no transaction) and the forced one the node rejects (no fee). The paid overwrite attempts (≈ 0.6 DUST each) are proven on the local chain (examples/upgrade-existing-contract/README.md).',
        "{firstHeight} = the deploy height − 1 and {lastHeight} = the highest inclusion height of this case's record: the scan covers the mint before the upgrade and the publish after it.",
      ],
      steps: [
        deploy(['--adapter', `${EX}/legacy/mip0018.adapter.ts`, '--args', sh([ds])]),
        {
          id: 'mint',
          runner: 'signer',
          wallet: 'wallet1',
          argv: [
            'call',
            NET,
            S1,
            '--record',
            REC,
            '--circuit',
            'mint',
            '--args',
            sh([{ bytes: { $signer: 'coinPublicKey' } }, '1000', { $random: 32 }]),
            '--step',
            'mint',
          ],
          expectExit: 0,
          submits: 'call',
          note: 'owner mint of 1000 shielded coins to wallet 1 (emits nothing)',
        },
        { ...walletStatus(), note: 'wallet 1 holds the 1000 coins: their color as the wallet SDK sees it, BEFORE the upgrade' },
        inspect(
          'inspect-before',
          'wallet-free snapshot before the upgrade: entry points {mint}, one-key authority (counter 0), ledger-data hash',
        ),
        {
          id: 'wrong-signer',
          runner: 'signer',
          wallet: 'wallet1',
          argv: ['upgrade', NET, S1, ...UP, '--maintenance-key-file', U1_WRONG_KEY, '--no-call', '--step', 'wrong-signer'],
          expectExit: 1,
          expectOutput: "not in the contract's committee",
          note: 'insert signed by a key outside the committee: refused before submission (exit 1, no transaction)',
        },
        {
          id: 'wrong-signer-forced',
          runner: 'signer',
          wallet: 'wallet1',
          argv: [
            'upgrade',
            NET,
            S1,
            ...UP,
            '--maintenance-key-file',
            U1_WRONG_KEY,
            '--no-call',
            '--step',
            'wrong-signer-forced',
            '--force',
          ],
          expectExit: 1,
          expectOutput: 'Custom error: 135',
          note: 'the same, --force: the node rejects it (1010 Invalid Transaction, Custom error 135 = InvalidCommitteeSignature; local evidence) — not included, no fee',
        },
        {
          id: 'upgrade',
          runner: 'signer',
          wallet: 'wallet1',
          argv: ['upgrade', NET, S1, ...UP, '--step', 'upgrade'],
          expectExit: 0,
          submits: 'verifier-key-insert+call',
          note: 'preflight (layout, decode, authority) → VerifierKeyInsert(publishMetadata, v4) signed by the deploy-time maintenance key (0600 private state) → publishMetadata() through the upgrade-only build (record steps upgrade:insert, upgrade:call)',
        },
        inspect('inspect-after', 'after: entry points {mint, publishMetadata}, mint key unchanged, counter 1, ledger-data hash unchanged'),
        {
          id: 'verify-publish',
          runner: 'wallet-free',
          argv: ['verify', NET, '--record', REC, '--step', 'upgrade:call', '--expect', '@{case}/expect/publish.json', '--wait', '120'],
          expectExit: 0,
        },
        list(),
        {
          id: 'index',
          runner: 'wallet-free',
          argv: ['index', NET, '--from-height', '{firstHeight}', '--to-height', '{lastHeight}', '--state', '{out}/index', '--json'],
          expectExit: 0,
          stdout: 'index-summary.json',
          note: '{firstHeight} = the deploy height − 1; {lastHeight} = the highest inclusion height of the record',
        },
        {
          id: 'lookup',
          runner: 'wallet-free',
          argv: ['lookup', NET, '--record', REC, '--domain-sep', ds, '--kind', '1', '--state', '{out}/index', '--json'],
          expectExit: 0,
          stdout: 'lookup.json',
          note: 'the color of the pre-upgrade coins → (this contract, domainSep, kind 1) → the metadata published after the upgrade',
        },
        {
          ...walletStatus(),
          id: 'wallet-status-after',
          stdout: 'wallet-status-after.json',
          note: 'wallet 1 still holds the 1000 coins of that color',
        },
      ],
      recheck: {
        verify: [{ record: 'record.json', step: 'upgrade:call', expect: 'expect/publish.json' }],
        list: [{ record: 'record.json', expect: 'expected.json' }],
        noTransaction: [{ record: 'record.json', step: 'wrong-signer:insert' }],
        colors: [{ record: 'record.json', domainSep: ds, kind: 1, index: 'index', wallet: 'wallet-status.json', expectIdentity: identity }],
      },
      files: { 'expect/publish.json': publishExpect, 'expected.json': expected },
    });
  }
  return { cases };
}

const U1_DOMAIN = 'mip-0018:example:upgrade';
/** Throwaway signing key (not wallet material) in the signer's state directory, written before the case runs. */
const U1_WRONG_KEY = '/run/mip0018/state/u1-wrong-signer.key';

// ------------------------------------------------------------------------------------------------- rendering

const STAGENET: Record<string, string[]> = {
  '{net}': ['--network', 'stagenet'],
  '{signer}': ['--mnemonic-file', '/run/mip0018/secrets/stagenet-wallet.mnemonic', '--wallet-cache', '/run/mip0018/state/wallet1.cache'],
  '{signer2}': [
    '--mnemonic-file',
    '/run/mip0018/secrets/stagenet-wallet-2.mnemonic',
    '--wallet-cache',
    '/run/mip0018/state/wallet2.cache',
    '--private-state',
    '/run/mip0018/state/wallet2-private-state.json',
  ],
};
const quote = (a: string) => (/^[\w@%+=:,./{}-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`);

function renderStagenet(c: CaseDef, s: Step): string {
  const dir = `deployments/stagenet/cases/${c.id}`;
  const argv = s.argv
    .flatMap((a) => STAGENET[a] ?? [a])
    .map((a) => a.replace(/\{out:(\w+)\}/gu, 'deployments/stagenet/cases/$1').replace(/\{case\}|\{out\}/gu, dir));
  const cmd = s.script
    ? `docker/run.sh exec ${quote(`node ${s.script} ${argv.map(quote).join(' ')}`)}`
    : `${s.runner === 'signer' ? 'signer' : 'wallet_free'} ${argv.map(quote).join(' ')}`;
  return s.stdout ? `${cmd} > ${dir}/${s.stdout}` : cmd;
}

function readme(c: CaseDef): string {
  const lines = [
    `# ${c.id} — ${c.title}`,
    '',
    "<!-- Generated by deployments/stagenet/tools/prepare-cases.ts from the examples' metadata.json and the vectors; do not edit. -->",
    '',
    `**Demonstrates**: ${c.demonstrates}`,
    '',
    `**Expected conclusion** (from the reference reducer, before any transaction): ${c.conclusion}`,
    '',
    ...(c.dependsOn ? [`**Runs after**: ${c.dependsOn.join(', ')}`, ''] : []),
    ...(c.notes ? [...c.notes.map((n) => `- ${n}`), ''] : []),
    '## Steps (Stagenet)',
    '',
    'Values filled in by S5 when it runs: the records (`record.json`), observations (`observed-*.json`, `wallet-status.json`) and the transaction table below. Shell set-up (bash or zsh; S5 plan §S5a; the secret directory is mounted read-only into the signer container only):',
    '',
    '```sh',
    'signer() {',
    '  MIP0018_SECRET_DIR="$HOME/.local/share/mips/00013-mip-0018-reference/private" \\',
    '  MIP0018_STATE_DIR="<0700 state directory outside the repository>" \\',
    '  MIP0018_DOCKER_NETWORK="<network of the two proof servers>" \\',
    '  MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=<proof-server 9.0.0-rc.8 URL> -e MIP0018_WALLET_PROOF_SERVER_URL=<proof-server 9.0.0-rc.6 URL>" \\',
    '  docker/signer.sh mip0018 -- "$@"',
    '}',
    'wallet_free() { docker/run.sh mip0018 -- "$@"; }',
    '```',
    '',
    '| # | Step | Wallet | Exit | Command |',
    '|---|---|---|---|---|',
    ...c.steps.map(
      (s, i) =>
        `| ${i + 1} | \`${s.id}\`${s.note ? ` — ${s.note}` : ''} | ${s.wallet ?? 'none'} | ${s.expectExit}${s.expectOutput ? ` (output contains \`${s.expectOutput}\`)` : ''} | \`${renderStagenet(c, s).replace(/\|/gu, '\\|')}\` |`,
    ),
    '',
    '## Re-check (wallet-free, one command)',
    '',
    '```sh',
    `docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/${c.id}`,
    '```',
    '',
    ...recorded(c),
  ];
  return `${lines.join('\n')}\n`;
}

/** Thousands separators for a SPECK amount; ≈ DUST with 3 decimals (1 DUST = 10^15 SPECK). */
const speck = (v: string) => BigInt(v).toLocaleString('en-US');
const dust = (v: string) => (Number(BigInt(v) / 1_000_000_000_000n) / 1000).toFixed(3);

/**
 * The README's record section: from the case's run record(s) when S5 has written them (public data only), else the
 * placeholder table. Rendering only reads the records, so `--check` stays exact once they are committed.
 */
function recorded(c: CaseDef): string[] {
  const dir = join(CASES, c.id);
  const p = join(dir, 'record.json');
  if (c.id === 'IDX') {
    const st = join(dir, 'index', 'index-state.json');
    if (!existsSync(st)) return ['## Scan (filled in by S5)', '', '_S5_: the scanned range and the colors found.', ''];
    const s = JSON.parse(readFileSync(st, 'utf8')) as {
      fromHeight: number;
      nextHeight: number;
      colors: Record<
        string,
        {
          contractAddress: string;
          domainSep: string;
          shielded?: { amount: string; firstMint: { height: number } };
          unshielded?: { amount: string; firstMint: { height: number } };
        }
      >;
    };
    return [
      '## Scan (Stagenet)',
      '',
      `Blocks ${s.fromHeight}–${s.nextHeight - 1} (state \`index/index-state.json\`). Colors minted in that range:`,
      '',
      '| Color | Contract | domainSep | Shielded (first mint) | Unshielded (first mint) |',
      '|---|---|---|---|---|',
      ...Object.entries(s.colors)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([color, e]) =>
            `| \`${color}\` | \`${e.contractAddress}\` | \`${e.domainSep}\` | ${e.shielded ? `${e.shielded.amount} (${e.shielded.firstMint.height})` : '—'} | ${e.unshielded ? `${e.unshielded.amount} (${e.unshielded.firstMint.height})` : '—'} |`,
        ),
      '',
    ];
  }
  if (!existsSync(p))
    return [
      '## Transactions (filled in by S5)',
      '',
      '| Step | Transaction hash | Block | Fee (SPECK) |',
      '|---|---|---|---|',
      ...c.steps.filter((s) => s.submits).map((s) => `| \`${s.id}\` | _S5_ | _S5_ | _S5_ |`),
      '',
    ];
  const r = JSON.parse(readFileSync(p, 'utf8')) as {
    contract: { name: string; address?: string; attached?: { from: string } };
    signer?: { unshieldedAddress: string };
    steps: {
      id: string;
      kind: string;
      circuit?: string;
      state: string;
      skipped?: string;
      error?: string;
      tx?: { hash: string };
      inclusion?: { height: number; hash: string; status: string; fee?: string };
    }[];
  };
  const fees = r.steps.map((s) => s.inclusion?.fee).filter((f): f is string => f !== undefined);
  const total = fees.reduce((a, f) => a + BigInt(f), 0n).toString();
  const what = (s: (typeof r.steps)[number]) => `${s.kind}${s.circuit ? ` \`${s.circuit}\`` : ''}`;
  const outcome = (s: (typeof r.steps)[number]) =>
    s.inclusion
      ? s.inclusion.status
      : s.skipped
        ? `skipped (${s.skipped.split('\n')[0]!.slice(0, 80)})`
        : s.error && !s.tx
          ? 'refused before submission (no transaction)'
          : s.error
            ? `not included: ${s.error.split('\n')[0]!.slice(0, 100)}`
            : s.state;
  return [
    '## Transactions (Stagenet, from `record.json`)',
    '',
    `Contract \`${r.contract.name}\` at \`${r.contract.address ?? '(not deployed)'}\`${r.contract.attached ? ` (attached from ${r.contract.attached.from})` : ''}${r.signer ? `; signer ${r.signer.unshieldedAddress}` : ''}.`,
    '',
    '| Step | What | Transaction hash | Block | Outcome | Fee (SPECK) | ≈ DUST |',
    '|---|---|---|---|---|---:|---:|',
    ...r.steps.map(
      (s) =>
        `| \`${s.id}\` | ${what(s)} | ${s.tx ? `\`${s.tx.hash}\`` : '—'} | ${s.inclusion ? `${s.inclusion.height} (\`${s.inclusion.hash.slice(0, 16)}…\`)` : '—'} | ${outcome(s).replace(/\|/gu, '\\|')} | ${s.inclusion?.fee ? speck(s.inclusion.fee) : '—'} | ${s.inclusion?.fee ? dust(s.inclusion.fee) : '—'} |`,
    ),
    ...(fees.length ? [`| **total** | | | | | **${speck(total)}** | **${dust(total)}** |`] : []),
    '',
  ];
}

function indexReadme(cases: CaseDef[]): string {
  return `${[
    '# Stagenet case folders',
    '',
    '<!-- Generated by deployments/stagenet/tools/prepare-cases.ts; do not edit. -->',
    '',
    "Prepared before any transaction: each folder holds `case.json` (one `mip0018` command per step, the exit code each must end with, the re-check list), `expected.json` (what the reference consumer must conclude, derived from the examples' metadata.json / the vectors) and `expect/*.json` (what `verify` must find per transaction). S5 runs the steps on Stagenet and adds the records and observations; `mip0018 recheck --network stagenet --case <folder>` re-checks a case wallet-free.",
    '',
    '| Case | What | Expected conclusion | Steps | Transactions |',
    '|---|---|---|---:|---:|',
    ...cases.map(
      (c) =>
        `| [${c.id}](${c.id}/README.md) | ${c.title} | ${c.conclusion} | ${c.steps.length} | ${c.steps.filter((s) => s.submits && s.expectExit === 0).length} |`,
    ),
    '',
    `Regenerate: \`docker/run.sh exec 'node deployments/stagenet/tools/prepare-cases.ts'\` (\`--check\` in CI).`,
  ].join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------- write / check

function outputs(): Map<string, string> {
  const { cases } = build();
  const out = new Map<string, string>();
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  for (const c of cases) {
    const dir = join(CASES, c.id);
    out.set(
      join(dir, 'case.json'),
      json({
        kind: 'mip0018-case',
        schema: 1,
        id: c.id,
        title: c.title,
        demonstrates: c.demonstrates,
        conclusion: c.conclusion,
        mip: MIP,
        source: c.source,
        ...(c.dependsOn ? { dependsOn: c.dependsOn } : {}),
        ...(c.notes ? { notes: c.notes } : {}),
        placeholders: {
          '{net}': 'network options (Stagenet: --network stagenet)',
          '{signer}': "wallet 1's signer options (mnemonic file, wallet cache)",
          '{signer2}': "wallet 2's signer options, with its OWN private-state file",
          '{case}': 'this case folder',
          '{out}': 'where records and observations are written (Stagenet: this case folder)',
          '{out:<ID>}': "another case's output folder",
          ...(c.id === 'IDX'
            ? { '{firstHeight}': 'lowest inclusion height of the matrix records − 10', '{lastHeight}': 'highest inclusion height' }
            : {}),
        },
        steps: c.steps,
        expected: 'expected.json',
        recheck: c.recheck,
      }),
    );
    for (const [f, v] of Object.entries(c.files)) out.set(join(dir, f), json(v));
    out.set(join(dir, 'README.md'), readme(c));
  }
  out.set(join(CASES, 'README.md'), indexReadme(cases));
  return out;
}

/** Generated files in a case folder (records and observations written by S5 are never touched). */
const generated = (rel: string) =>
  /^(case\.json|expected(-after-[\w-]+)?\.json|README\.md|expect\/[\w-]+\.json|args\/[\w-]+\.json)$/u.test(rel);

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}

const check = process.argv.includes('--check');
const want = outputs();
const stale: string[] = [];
for (const [p, text] of want) {
  const have = existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  if (have === text) continue;
  if (check) stale.push(relative(REPO, p));
  else {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}
for (const e of existsSync(CASES) ? readdirSync(CASES, { withFileTypes: true }) : []) {
  if (!e.isDirectory()) continue;
  const id = e.name;
  for (const rel of walk(join(CASES, id))) {
    const p = join(CASES, id, rel);
    if (generated(rel) && !want.has(p)) {
      if (check) stale.push(`${relative(REPO, p)} (no longer generated)`);
      else rmSync(p);
    }
  }
}
if (check && stale.length) {
  process.stderr.write(`stale case files (run node deployments/stagenet/tools/prepare-cases.ts):\n  ${stale.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write(`${check ? 'checked' : 'wrote'} ${want.size} files in ${relative(REPO, CASES)}\n`);
