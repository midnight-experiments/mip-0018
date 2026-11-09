// SPDX-License-Identifier: Apache-2.0
//
// Prepares the case folders deployments/<network>/cases/<ID>/ (C01–C10, C12, IDX, U1) of one public network BEFORE any
// transaction:
//
//   case.json        what the case demonstrates, one `mip0018` command per step (placeholders below), the exit code
//                    each must end with, and the "recheck" list behind `mip0018 recheck --case <dir>`
//   expected.json    the consumer state the case must end in — computed from the example's metadata.json payloads
//                    (or the vectors) with the reference reducer `@mip0018/consumer`, and cross-checked against the
//                    example's own `expected` where it has one; never from an observation
//   expect/*.json    per transaction: what `check-event` must find (result, reason, exact name and payload per event)
//   args/*.json      circuit arguments too long for a command line (the raw emitter's 288-byte events)
//   README.md        the commands rendered for that network, and the transactions of the case's run record
//
//   node deployments/tools/prepare-cases.ts --network <preview|preprod|mainnet>   (re)write every case folder
//   node deployments/tools/prepare-cases.ts --network <id> --check                exit 1 when a committed file
//                                                                                 differs (CI)
//   node deployments/tools/prepare-cases.ts --network <id> --dir <dir>            the folders under <dir> instead
//                                                                                 (the local end-to-end test)
//
// Placeholders in a step's argv (expanded by whoever runs the case — the signer on the public network, the local
// end-to-end test on the local stack): "{net}" / "{signer}" / "{signer2}" are whole arguments that expand to several
// options; "{case}" (this folder), "{out}" (where the records and observations go — this folder on the public
// network) and "{out:<ID>}" (another case's output folder) are replaced inside arguments; "{firstHeight}" /
// "{lastHeight}" (IDX only) are the lowest inclusion height of the matrix minus 10 and the highest one, read from the
// records.
//
// No network access, no wallet: run it anywhere
// (`docker/run.sh exec 'node deployments/tools/prepare-cases.ts --network preview'`).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classifyEvent, commonRecords, decodePayload, encodePayload, fromHex, toHex, withdrawRecords } from '@mip0018/codec';
import { MetadataState } from '@mip0018/consumer';
import {
  compareState,
  projectState,
  PUBLIC_NETWORKS,
  tokenType,
  type ExpectedField,
  type ExpectedIdentity,
  type ExpectedState,
  type PublicNetworkId,
} from '@mip0018/midnight';
import type { PublishCall } from '@mip0018/midnight/signer';
import {
  callOf as minimalCallOf,
  lifecycleCalls as minimalLifecycle,
  metadataOf as minimalMeta,
} from '../../examples/minimal/src/adapter.ts';
import { callOf as ozCallOf, metadataOf as ozMeta } from '../../examples/openzeppelin/src/adapter.ts';
import type { ExampleName } from '../../examples/openzeppelin/src/examples.ts';

const REPO = join(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({
  options: { network: { type: 'string' }, check: { type: 'boolean', default: false }, dir: { type: 'string' } },
});
if (args.network === undefined || !Object.hasOwn(PUBLIC_NETWORKS, args.network)) {
  process.stderr.write(`--network <${Object.keys(PUBLIC_NETWORKS).join('|')}> is required\n`);
  process.exit(2);
}
const NETWORK = args.network as PublicNetworkId;
/** The network's name in prose ("Preview"). */
const TITLE = `${NETWORK[0]!.toUpperCase()}${NETWORK.slice(1)}`;
/** The variable holding the network's Blockfrost project token, if its endpoints take one. */
const TOKEN_VARIABLE = PUBLIC_NETWORKS[NETWORK].tokenVariable;
/** The committed place of the case folders (the rendered commands always name it). */
const CASES_REL = `deployments/${NETWORK}/cases`;
/** Where this run reads and writes them. */
const CASES = args.dir === undefined ? join(REPO, CASES_REL) : resolve(args.dir);
// The pinned MIP text (toolchain.json); every case.json cites it (`npm run check:mip-pin`).
const MIP = {
  commit: (JSON.parse(readFileSync(join(REPO, 'toolchain.json'), 'utf8')) as { mip: { commit: string } }).mip.commit,
  eventName: 'mip-0018:token-metadata[v1]',
};
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
  checkEvent?: { record: string; step: string; expect: string }[];
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
        network: NETWORK,
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

/** The check-event expectation of a call (exact name + payload per event, and the result). */
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
const checkEvent = (step: string): Step => ({
  id: `check-event-${step}`,
  runner: 'wallet-free',
  argv: ['check-event', NET, '--record', REC, '--step', step, '--expect', `@{case}/expect/${step}.json`, '--wait', '120', '--json'],
  expectExit: 0,
  stdout: `observed-check-event-${step}.json`,
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
  const checks: Recheck['checkEvent'] = [];
  for (const c of calls) {
    steps.push(call(c));
    if ((c.expect ?? []).length > 0) {
      files[`expect/${c.stepId}.json`] = expectOf(c);
      checks.push({ record: 'record.json', step: c.stepId!, expect: `expect/${c.stepId}.json` });
    }
  }
  for (const v of checks) steps.push(checkEvent(v.step));
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
      recheck: { checkEvent: checks, list: [{ record: 'record.json', expect: 'expected.json' }], ...(colors.length ? { colors } : {}) },
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
  /** C07's events in order (C12 runs on the same contract afterwards). */
  const c07Events: { name: string; payload: string }[][] = [];

  const c01 = ozCase(
    'C01',
    'fungible-token',
    'OpenZeppelin FungibleToken (kind 3): deploy, publish',
    'The common fields in one event from an OpenZeppelin token; kind 3 has no color.',
    '1 kind-3 identity with 3 usable fields (name "Acme Gold", symbol "AGLD", decimals 6); no standards; no color.',
    {
      notes: [
        `The OpenZeppelin examples publish no \`standards\`: \`standards\` is a self-declaration, and OpenZeppelin Compact Contracts claims no MIP. The A1 shape (with standards) on ${TITLE} is C06 and C10 (examples/minimal).`,
      ],
    },
  );
  const c02 = ozCase(
    'C02',
    'native-shielded',
    'OpenZeppelin NativeShieldedToken (kind 1): deploy, mint, publish',
    'color = tokenType(domainSep, contract) = the color of the shielded coin minted to wallet 1.',
    '1 kind-1 identity ("Acme Shield", "ASHD", 6) with a color equal to the minted coin color.',
    { wallet: true },
  );
  const c03 = ozCase(
    'C03',
    'native-unshielded',
    'Native unshielded token (kind 2; std-lib mintUnshieldedToken + OpenZeppelin Ownable): deploy, mint to wallet 1, publish',
    "color = wallet 1's UTXO token type; IDX resolves that color back to the identity.",
    '1 kind-2 identity ("Acme Public", "APUB", 6) whose color is the token type of the UTXO wallet 1 received.',
    { wallet: true },
  );
  const c04 = ozCase(
    'C04',
    'multi-kind',
    'One asset in kinds 1, 2, 3 (OpenZeppelin NativeShieldedToken + FungibleToken, std-lib unshielded): deploy, three mints, publish',
    'Symbol grouping on chain (vector S9): three identities under one domainSep and symbol form one group; kinds 1 and 2 share one color.',
    '3 identities ("Acme Dollar", "ACD", 2) in ONE group "ACD"; kinds 1 and 2 colored (same color), kind 3 not.',
    {
      wallet: true,
      notes: ['The three identities are published by ONE publishMetadata() transaction with three events.'],
    },
  );
  const c05 = ozCase(
    'C05',
    'token-family',
    'OpenZeppelin NativeShieldedTokenFamily: deploy, mint gold + silver, publish three domains',
    'Separate identities per domainSep (vector S6) in one contract.',
    '3 kind-1 identities ("Acme Medals", "MEDAL", 0), one per domain, in one group "MEDAL"; three distinct colors.',
    {
      wallet: true,
      notes: ['publishMetadata(domain) is called three times (three transactions); bronze is published but never minted.'],
    },
  );
  for (const c of [c01, c02, c03, c04, c05]) {
    cases.push(c.def);
    expectedOf[c.def.id] = c.expected;
  }

  // C06 — minimal OwnerKey lifecycle: publish (A1), rename, withdraw (one event, a Null record for each of the six
  // common keys), withdraw again, revive. Every payload is the one examples/minimal/owner-key.metadata.json states for
  // this tree's contract (examples/minimal/test/adapter.test.ts checks that the contract emits exactly these); the
  // withdraw payload is also re-built with the codec.
  {
    const meta = minimalMeta('OwnerKey');
    const publish = { ...minimalCallOf(meta.steps[0]!) };
    const life = minimalLifecycle('OwnerKey'); // rename, withdraw, withdraw-again, revive
    const files: Record<string, unknown> = {};
    const steps: Step[] = [deploy(['--adapter', 'examples/minimal/owner-key.mip0018.adapter.ts'])];
    const evs: { name: string; payload: string }[][] = [];
    const checks: Recheck['checkEvent'] = [];
    const lists: Recheck['list'] = [];
    for (const c of [publish, ...life]) {
      const force = c.stepId === 'withdraw-again';
      steps.push(
        call(c, {
          force,
          ...(force
            ? {
                note: 'the identity is already gone, so the before-check sees no change and would skip it: --force emits it anyway (vector S3b)',
              }
            : {}),
        }),
      );
      evs.push(eventsOf(c));
      const state = reduce(evs);
      sameState(state, C06_EXPECTED[c.stepId!]!, `C06 after ${c.stepId}`);
      // and the example's own expectation for that step (metadata.json; after a withdrawal it lists no identity)
      const own = c.stepId === 'publish' ? meta.expected : meta.lifecycle.find((l) => l.id === c.stepId)!.expected!;
      sameState(state, own, `C06 after ${c.stepId} (metadata.json)`);
      files[`expect/${c.stepId}.json`] = expectOf(c);
      files[`expected-after-${c.stepId}.json`] = state;
      steps.push(checkEvent(c.stepId!));
      steps.push(list(`expected-after-${c.stepId}.json`, `list-after-${c.stepId}`));
      checks.push({ record: 'record.json', step: c.stepId!, expect: `expect/${c.stepId}.json` });
      lists.push({ record: 'record.json', expect: `expected-after-${c.stepId}.json`, atStep: c.stepId! });
    }
    // the withdraw event: header + a Null record for each of the six common keys, as the codec builds it
    for (const id of ['withdraw', 'withdraw-again']) {
      const [w, ...more] = expectOf(life.find((c) => c.stepId === id)!);
      if (more.length || w!.payload !== toHex(encodePayload({ domainSep: fromHex(w!.domainSep!), kind: w!.kind! }, withdrawRecords())))
        throw new Error(`C06 ${id}: the payload is not one event with the six Null records`);
    }
    const final = reduce(evs);
    files['expected.json'] = final;
    lists.push({ record: 'record.json', expect: 'expected.json' });
    expectedOf.C06 = final;
    cases.push({
      id: 'C06',
      title:
        'Minimal OwnerKey (kind 3, no OpenZeppelin) lifecycle: deploy, publish, rename, withdraw (six Null records, one event), withdraw again, revive',
      demonstrates:
        'MIP "Applying records" on chain: latest value wins (S2); one event with a Null record for each common key (name, symbol, decimals, standards, image, image_sha256) deletes every field, so the token identity is not referenced at all — not listed, in no group, as if it had never been described (S3c); a repeated withdrawal changes nothing (S3b); a later record describes it again with only that field (the revive: name and symbol; decimals and standards do not return, S3d).',
      conclusion:
        'after publish: name "Acme Token", symbol "ACME", decimals 6, standards "mip-0004" (group "ACME"); after rename: name "Acme Prime", symbol "ACMP", decimals and standards unchanged (group "ACMP"); after withdraw and after withdraw again: no identity and no group (`list`: identities none); final: ONLY name "Acme Again" and symbol "ACMA" (group "ACMA"); the publish payload = MIP Appendix A byte-for-byte, the withdraw payload = header + the six Null records.',
      source: {
        example: 'examples/minimal',
        contract: 'examples/minimal/contracts/OwnerKey.compact',
        metadata: 'examples/minimal/owner-key.metadata.json',
      },
      notes: [
        'withdrawMetadata() emits one event with a Null record for each of the six common keys; the token never had image or image_sha256, and a Null record for a field without a value has no effect.',
        'Kind 3 has no color, so there is no color lookup: per the MIP "Lookup" section a contract token is found by querying the contract\'s kind-3 events, which is `list` — after the withdrawal it must show no identity for (0x11…, 3) and no group.',
        'OwnerKey renames with setMetadata(name, symbol), so the revive sets name and symbol (10- and 4-byte values: "Acme Again"/"ACMA").',
        'A Null record that deletes a single key while the other fields stay is shown on chain by C12 (steps s3a-publish and s3a-delete-name, vector S3a).',
        "Every intermediate state is re-checkable: `recheck` lists the contract as of each step's block (`list --to-block`).",
      ],
      steps,
      recheck: { checkEvent: checks, list: lists },
      files,
    });
  }

  // C07 — raw emitter: capacity, accepted edge cases, malformed, foreign names. Each step emits one vector's event;
  // the step id is the vector id, except step A3c, which emits vector R5i (a key that is not valid UTF-8).
  {
    const STEP_VECTOR: Record<string, string> = { A3c: 'R5i' };
    const vectorOf = (id: string) => STEP_VECTOR[id] ?? id;
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
    const checks: Recheck['checkEvent'] = [];
    for (const id of ids) {
      const v = vector(vectorOf(id));
      const cl = classifyEvent({ type: 'Misc', name: fromHex(v.event.name_hex), payload: fromHex(v.event.payload_hex) });
      if (cl.result !== v.expect.result || ('reason' in cl ? cl.reason : undefined) !== v.expect.reason)
        throw new Error(`C07: the codec classifies ${vectorOf(id)} as ${cl.result}, the vector says ${v.expect.result}`);
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
        note: `vector ${vectorOf(id)}: ${v.expect.result}${v.expect.reason ? ` (${v.expect.reason})` : ''}`,
      });
      evs.push([{ name: v.event.name_hex, payload: v.event.payload_hex }]);
      checks.push({ record: 'record.json', step: id, expect: `expect/${id}.json` });
    }
    for (const v of checks) steps.push(checkEvent(v.step));
    steps.push(list());
    const expected = reduce(evs, { fields: true, counts: true });
    files['expected.json'] = expected;
    expectedOf.C07 = expected;
    c07Events.push(...evs);
    const result = (id: string) => vector(vectorOf(id)).expect.result;
    cases.push({
      id: 'C07',
      title:
        'Raw emitter (test-only): capacity, exact-bytes and non-tombstone edge cases accepted; malformed payloads rejected; other names ignored',
      demonstrates:
        "A2a/A2b capacity, A3a/A3b exact bytes, A4b Uint<128> decimals, A5a–c non-tombstones accepted; R1, R2a, R3a, R3b, R4a, R5a, R5e, R5h, R5i (a key that is not valid UTF-8, step A3c), R6b rejected whole; I1a/I1b ([v2]) and I2a/I2b (other names) ignored — each checked with its reason; the contract's state is what the accepted ones set, and a consumer serves only its common keys.",
      conclusion: `${ids.filter((i) => result(i) === 'accept').length} accepted, ${ids.filter((i) => result(i) === 'reject').length} rejected, ${ids.filter((i) => result(i) === 'ignore').length} ignored events; one identity (0x11…/3) whose served fields are the common keys the accepted records set (expected.json lists every served field); the other accepted keys are not served.`,
      source: { contract: 'test-contracts/raw-emitter', vectors: 'vectors/payload' },
      notes: [
        "--force: accepted vectors are emitted even when they would not change the state (without it, the before-check skips a call whose accepted events leave the contract's state unchanged); rejected and ignored ones are never skipped.",
        'Step ids are the vector ids, except step A3c, which emits the event of vector R5i (key ff 6b 65 79): rejected, because keys MUST be valid UTF-8.',
        "The contract also carries case C12's events (later blocks; two more identities: C12's own domainSep with kind 3, and kind 1 under 0x11…): the list check reads the state as of step I2b's block (`list --to-block`).",
      ],
      steps,
      recheck: { checkEvent: checks, list: [{ record: 'record.json', expect: 'expected.json', atStep: 'I2b' }] },
      files,
    });
  }

  // C12 — MIP-0018 PR #372 rules on chain through C07's raw emitter (no deployment). Steps a6–s12b: one identity under
  // its own domainSep (kind 3), each event carrying the records of the named vector under that header — image and
  // image_sha256 (A6), a key that is not served (S10a), name and symbol over their lengths (S11), a 31-byte image_sha256
  // (S12b). Steps s3a-publish and s3a-delete-name: vector S3a's two kind-1 events, byte for byte (domainSep 0x11…,
  // kind 1) — a Null record at `name` deletes only `name`. The contract also holds C07's identity (0x11…/3), so every
  // state lists all three.
  {
    const domainSep = C12_DS;
    const header = { domainSep: fromHex(domainSep), kind: 3 };
    const files: Record<string, unknown> = {};
    const steps: Step[] = [];
    const checks: Recheck['checkEvent'] = [];
    const lists: Recheck['list'] = [];
    const evs: { name: string; payload: string }[][] = [...c07Events];
    /** One identity of a state and the groups it is a member of. */
    const part = (state: ExpectedState, ds: string, kind: number): ExpectedState => ({
      identities: state.identities.filter((i) => i.domainSep === ds && i.kind === kind),
      groups: state.groups.filter((g) => g.members.some((m) => m.domainSep === ds && m.kind === kind)),
    });
    const c07Identity = expectedOf.C07!.identities.find((i) => i.domainSep === DS11 && i.kind === 3)!;
    const all = [
      ...C12_STEPS.map((c) => ({
        id: c.id,
        note: c.note,
        event: { name: EVENT_NAME_HEX, payload: toHex(encodePayload(header, c.records())) },
        mine: { domainSep, kind: 3, expected: { identities: [C12_EXPECTED[c.id]!], groups: C12_GROUPS[c.id]! } },
      })),
      ...C12_S3A.map((c) => ({
        id: c.id,
        note: c.note,
        event: vectorEvent('state/S3a.json', c.step),
        mine: { domainSep: DS11, kind: 1, expected: c.expected },
      })),
    ];
    for (const c of all) {
      const { name, payload } = c.event;
      const cl = classifyEvent({ type: 'Misc', name: fromHex(name), payload: fromHex(payload) });
      if (name !== EVENT_NAME_HEX || cl.result !== 'accept') throw new Error(`C12 ${c.id}: the codec does not accept the event`);
      const { domainSep: ds, kind } = c.mine;
      files[`args/${c.id}.json`] = [name, payload];
      files[`expect/${c.id}.json`] = [{ result: 'accept', name, payload, domainSep: ds, kind }];
      steps.push({
        id: c.id,
        runner: 'signer',
        wallet: 'wallet1',
        argv: [
          'publish',
          NET,
          S1,
          '--example',
          'raw-emitter',
          ...(steps.length === 0 ? ['--attach', '@{out:C07}/record.json'] : []),
          '--record',
          REC,
          '--circuit',
          'emitRaw',
          '--args',
          `@{case}/args/${c.id}.json`,
          '--step',
          c.id,
          '--force',
        ],
        expectExit: 0,
        submits: 'call',
        note: c.note,
      });
      evs.push([{ name, payload }]);
      const state = reduce(evs, { fields: true, counts: true });
      sameState(part(state, ds, kind), c.mine.expected, `C12 after ${c.id}`);
      // the other identities on the contract stay as the steps before left them
      if (ds === DS11)
        sameState(part(state, domainSep, 3), { identities: [C12_EXPECTED.s12b!], groups: C12_GROUPS.s12b! }, `C12 after ${c.id}`);
      sameState(part(state, DS11, 3), { identities: [c07Identity], groups: part(expectedOf.C07!, DS11, 3).groups }, `C12 after ${c.id}`);
      files[`expected-after-${c.id}.json`] = state;
      checks.push({ record: 'record.json', step: c.id, expect: `expect/${c.id}.json` });
      lists.push({ record: 'record.json', expect: `expected-after-${c.id}.json`, atStep: c.id });
    }
    for (const c of all) {
      steps.push(checkEvent(c.id));
      steps.push(list(`expected-after-${c.id}.json`, `list-after-${c.id}`));
    }
    const final = reduce(evs, { fields: true, counts: true });
    // the kind-1 identity ends exactly as vector S3a states it (every field: key, value type, value, usability)
    {
      const v = JSON.parse(readFileSync(join(REPO, 'vectors', 'state', 'S3a.json'), 'utf8')) as {
        expect: { identities: { domainSep: string; kind: number; fields: Record<string, ExpectedField> }[] };
      };
      const want = v.expect.identities.find((i) => `0x${i.domainSep}` === DS11 && i.kind === 1)!;
      const got = final.identities.find((i) => i.domainSep === DS11 && i.kind === 1)!;
      const fields = Object.fromEntries(
        Object.entries(want.fields).map(([k, f]) => [
          k,
          { key_text: f.key_text, valType: f.valType, value_hex: f.value_hex, usable: f.usable },
        ]),
      );
      sameState({ identities: [got], groups: [] }, { identities: [{ ...got, fields }], groups: [] }, 'C12 (0x11…/1) = vector S3a');
    }
    files['expected.json'] = final;
    lists.push({ record: 'record.json', expect: 'expected.json' });
    expectedOf.C12 = final;
    cases.push({
      id: 'C12',
      title:
        "Raw emitter (test-only), C07's contract: image and image_sha256, a key that is not served, name and symbol over their lengths, a 31-byte image_sha256, a Null record that deletes one key",
      demonstrates:
        'MIP-0018 PR #372 on chain through C07\'s owner-gated raw emitter. One identity (kind 3, its own domainSep): A6 image (type 4) and a 32-byte image_sha256 (type 0) in one event, both served and usable; S10a a record foo = "x" is accepted and not served; S11 a 70-character name and a 15-character symbol (grapheme clusters: combining marks, flags, Hangul L+V+T jamo) are usable and served as their first 64 / 12 characters; S12b a 31-byte image_sha256 is unusable. A second identity (kind 1, domainSep 0x11…), vector S3a\'s kind-1 events byte for byte: a Null record at `name` deletes only `name` — the identity keeps symbol, decimals and standards (MIP "Applying records").',
      conclusion:
        'after a6: image and image_sha256 usable; after s10a: unchanged (foo is not served); after s11: name and symbol served truncated (the stored bytes are unchanged); after s12b: image_sha256 unusable, the other fields unchanged; after s3a-publish: a kind-1 identity (0x11…/1) with name "Gold", symbol "GLD", decimals 6, standards "mip-0011" (group "GLD"); after s3a-delete-name: no name, symbol "GLD", decimals 6 and standards "mip-0011" kept (group "GLD"), as vector S3a states for kind 1. C07\'s identity (0x11…/3) is listed unchanged next to them.',
      source: {
        contract: 'test-contracts/raw-emitter',
        contractOf: 'C07',
        vectors: 'vectors/payload/A6.json, vectors/state/S10a.json, S11a.json, S11b.json, S12b.json, S3a.json',
      },
      dependsOn: ['C07'],
      notes: [
        `Steps a6, s10a, s11 and s12b: domainSep = pad(32, "${C12_DOMAIN}"), kind 3; each event carries the records of the named vector under this header.`,
        "Steps s3a-publish and s3a-delete-name emit vector S3a's kind-1 events (its block 1 event 0 and its block 2 event) byte for byte: domainSep 0x11…, kind 1, so a kind-1 identity next to C07's kind-3 one. S3a's kind-3 event is not emitted: C07's identity has that domainSep and kind.",
        "`--attach @{out:C07}/record.json` starts this case's own record for C07's contract (C07's record is not touched); wallet 1 is the raw emitter's owner.",
        '--force: s10a leaves the served state unchanged, so the before-check would skip it; --force emits every step.',
        "C07's identity (0x11…/3) is on the same contract: each expected state lists it as C07 left it, and the counts include C07's 22 events.",
      ],
      steps,
      recheck: { checkEvent: checks, list: lists },
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
      conclusion: 'One identity (0x11…/3) with only name = "Good"; 2 events: 1 accepted, 1 rejected (reserved-valtype).',
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
        checkEvent('emit-two'),
        list(),
      ],
      recheck: {
        checkEvent: [{ record: 'record.json', step: 'emit-two', expect: 'expect/emit-two.json' }],
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
      title: 'Minimal create-and-destroy (kind 3): deploy, publish, VerifierKeyRemove of publishMetadata, publish again',
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
        checkEvent('publish'),
        {
          id: 'remove-key',
          runner: 'signer',
          wallet: 'wallet1',
          argv: ['remove-circuit', NET, S1, '--record', REC, '--circuit', 'publishMetadata'],
          expectExit: 0,
          submits: 'verifier-key-remove',
          note: 'maintenance VerifierKeyRemove in the v4 slot (where ZKIR v3 keys live), signed with the maintenance key kept in the 0600 private-state file',
        },
        {
          ...call({ ...publish, stepId: 'publish-again' }, { force: true, expectExit: 1 }),
          expectOutput: 'has no verifier key',
          note: 'refused before submission: publishMetadata has no verifier key any more (exit 1, no transaction)',
        },
        list(),
      ],
      recheck: {
        checkEvent: [{ record: 'record.json', step: 'publish', expect: 'expect/publish.json' }],
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
        note: '{firstHeight} = the lowest inclusion height of the matrix records − 10; {lastHeight} = the highest (both read from the records)',
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
        'MIP "Lookup": from a start height, every native mint of C02–C05 is found once with its (contract, domainSep, kind), and each color resolves to its identity and current metadata.',
      conclusion:
        '6 minted colors (C02 shielded, C03 unshielded, C04 shielded + unshielded = one color, C05 gold, silver) resolve to their contract, domainSep and kind with the metadata of each case; C05 bronze (never minted) is "not minted in the scanned range".',
      source: { tool: 'mip0018 index / lookup' },
      dependsOn: ['C02', 'C03', 'C04', 'C05'],
      notes: [
        "U1 (the upgrade case, run after the matrix) scans its own block range and looks up its color in its own folder (cases/U1: steps index and lookup), so this scan stays the matrix's range.",
        `The index state lands in {out}/index/index-state.json (${CASES_REL}/IDX/index/ on ${TITLE}).`,
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

  // U1 — existing-contract upgrade: LegacyToken deployed WITHOUT an emitting circuit, a mint, then
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
      argv: ['{net}', '--record', REC, '--ledger', `${EX}/managed/LegacyToken`, '--ledger', `${EX}/managed/LegacyTokenMetadata`],
      expectExit: 0,
      stdout: `observed-${id}.json`,
      note,
    });
    cases.push({
      id: 'U1',
      title: 'Existing-contract upgrade: deploy a token without an emitting circuit, mint, VerifierKeyInsert(publishMetadata), publish',
      demonstrates:
        'MIP "Existing contracts": a maintenance VerifierKeyInsert adds publishMetadata() to a deployed kind-1 token; the event is bound to the ORIGINAL address, so the color of the coins minted before the upgrade is the identity\'s color; address, domainSep, coins and the other circuit stay as they were. A key outside the maintenance committee is refused.',
      conclusion:
        'same contract address before/after; entry points {mint} → {mint, publishMetadata} with the mint key unchanged; ledger data unchanged; 1 kind-1 identity ("Legacy Token", "LGCY", 6) whose color = the color of the coins wallet 1 received from the pre-upgrade mint; the scanner finds that mint before the insert and lookup resolves the color to the new metadata; the insert signed by another key is refused before submission and, forced, rejected by the node.',
      source: {
        example: EX,
        deployed: `${EX}/legacy/LegacyToken.compact`,
        upgrade: `${EX}/upgrade/LegacyTokenMetadata.compact`,
        guide: 'docs/upgrade-guide.md',
      },
      notes: [
        `domainSep = pad(32, "${U1_DOMAIN}") (a LegacyToken constructor argument; publishMetadata() reads it from the ledger).`,
        "The wrong-signer key is a throwaway ledger sampleSigningKey() in the signer state directory (0600) — never wallet material; it is not in the contract's one-key committee.",
        `On ${TITLE} only the free negatives run: the refused insert (no transaction) and the forced one the node rejects (no fee). The overwrite attempts that pay a VerifierKeyInsert fee are proven on the local chain (examples/upgrade-existing-contract/README.md).`,
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
          id: 'check-event-publish',
          runner: 'wallet-free',
          argv: [
            'check-event',
            NET,
            '--record',
            REC,
            '--step',
            'upgrade:call',
            '--expect',
            '@{case}/expect/publish.json',
            '--wait',
            '120',
            '--json',
          ],
          expectExit: 0,
          stdout: 'observed-check-event-publish.json',
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
        checkEvent: [{ record: 'record.json', step: 'upgrade:call', expect: 'expect/publish.json' }],
        list: [{ record: 'record.json', expect: 'expected.json' }],
        noTransaction: [{ record: 'record.json', step: 'wrong-signer:insert' }],
        colors: [{ record: 'record.json', domainSep: ds, kind: 1, index: 'index', wallet: 'wallet-status.json', expectIdentity: identity }],
      },
      files: { 'expect/publish.json': publishExpect, 'expected.json': expected },
    });
  }
  return { cases };
}

const DS11 = `0x${'11'.repeat(32)}`;
const kind3 = (common: Record<string, unknown>): ExpectedIdentity => ({ domainSep: DS11, kind: 3, colored: false, common });
const groupOf = (symbol: string) => [{ symbol, members: [{ domainSep: DS11, kind: 3 }] }];
const A1_COMMON = { name: 'Acme Token', symbol: 'ACME', decimals: 6, standards: 'mip-0004' };
/** C06's states, written by hand from the MIP's "Applying records" text; the generator checks the reducer agrees. */
const C06_EXPECTED: Record<string, ExpectedState> = {
  publish: { identities: [kind3(A1_COMMON)], groups: groupOf('ACME') },
  rename: { identities: [kind3({ ...A1_COMMON, name: 'Acme Prime', symbol: 'ACMP' })], groups: groupOf('ACMP') },
  withdraw: { identities: [], groups: [] },
  'withdraw-again': { identities: [], groups: [] },
  revive: { identities: [kind3({ name: 'Acme Again', symbol: 'ACMA' })], groups: groupOf('ACMA') },
};

/** The records of a vector's event: a payload vector, or one step of a state vector (decoded with the codec). */
function vectorRecords(file: string, step = 0, keys?: string[]) {
  const v = JSON.parse(readFileSync(join(REPO, 'vectors', file), 'utf8')) as {
    event?: { payload_hex: string };
    steps?: { payload_hex: string }[];
  };
  const d = decodePayload(fromHex(v.event?.payload_hex ?? v.steps![step]!.payload_hex));
  if (!d.ok) throw new Error(`${file}: the event is not accepted`);
  return d.records
    .filter((r) => keys === undefined || keys.includes(new TextDecoder().decode(r.key)))
    .map((r) => ({ key: r.key, valType: r.valType, value: r.value }));
}

const C12_DOMAIN = `mip-0018:${NETWORK}:C12`;
const C12_STEPS: { id: string; note: string; records: () => ReturnType<typeof vectorRecords> }[] = [
  { id: 'a6', note: 'vector A6: image (type 4) + 32-byte image_sha256 (type 0): accept', records: () => vectorRecords('payload/A6.json') },
  { id: 's10a', note: 'vector S10a: foo = "x": accept, not served', records: () => vectorRecords('state/S10a.json', 0) },
  {
    id: 's11',
    note: 'vectors S11a + S11b: a 70-character name and a 15-character symbol in one event: accept, served as their first 64 / 12 characters',
    records: () => [...vectorRecords('state/S11a.json', 0), ...vectorRecords('state/S11b.json', 0)],
  },
  {
    id: 's12b',
    note: 'vector S12b: a 31-byte image_sha256: accept, unusable',
    records: () => vectorRecords('state/S12b.json', 0, ['image_sha256']),
  },
];
const C12_DS = `0x${Buffer.from(C12_DOMAIN).toString('hex').padEnd(64, '0')}`;
const C12_IMAGE = {
  image: 'https://example.org/acme.png',
  imageSha256: 'df0e7f2208098c42ba231bd6ed5eacce4c7a7b21e4eb5ea1a79bccb0fa237464',
};
const c12 = (common: Record<string, unknown>): ExpectedIdentity => ({ domainSep: C12_DS, kind: 3, colored: false, common });
/** S11a's name truncated to 64 characters and S11b's symbol to 12 (grapheme clusters, written out by hand). */
const C12_NAME_64 =
  'Acme Cafe\u0301 token \u{1F1FA}\u{1F1FE} \u1112\u1161\u11AB\u1100\u1161\u11A8 A\u030Angstro\u0308\u0304m, seventy characters for test S11a\u{1F1EF}\u{1F1F5}';
const C12_SYMBOL_12 = 'A\u030ACMe\u0301\u{1F1FA}\u{1F1FE}\u1112\u1161\u11ABXYZo\u0308\u030412';
/** The stored 15-character symbol: groups compare the stored bytes. */
const C12_SYMBOL_15 = `${C12_SYMBOL_12}3\u{1F1EF}\u{1F1F5}\u1100\u1161\u11A8`;
/** C12's identity after each step, written by hand from the MIP text (served values only). */
const C12_EXPECTED: Record<string, ExpectedIdentity> = {
  a6: c12({ ...C12_IMAGE }),
  s10a: c12({ ...C12_IMAGE }),
  s11: c12({ ...C12_IMAGE, name: C12_NAME_64, symbol: C12_SYMBOL_12 }),
  s12b: c12({ image: C12_IMAGE.image, name: C12_NAME_64, symbol: C12_SYMBOL_12 }),
};
const C12_GROUP = [{ symbol: C12_SYMBOL_15, members: [{ domainSep: C12_DS, kind: 3 }] }];
const C12_GROUPS: Record<string, ExpectedState['groups']> = { a6: [], s10a: [], s11: C12_GROUP, s12b: C12_GROUP };

/** One event of a state vector, byte for byte (its name and its 256-byte payload). */
function vectorEvent(file: string, step: number): { name: string; payload: string } {
  const v = JSON.parse(readFileSync(join(REPO, 'vectors', file), 'utf8')) as { steps: { name_hex: string; payload_hex: string }[] };
  const e = v.steps[step]!;
  return { name: e.name_hex, payload: e.payload_hex };
}
const kind1 = (common: Record<string, unknown>): ExpectedIdentity => ({ domainSep: DS11, kind: 1, colored: true, common });
const S3A_GROUP = [{ symbol: 'GLD', members: [{ domainSep: DS11, kind: 1 }] }];
/** C12's kind-1 steps: vector S3a's kind-1 events (steps 0 and 2), and the identity after each, written by hand. */
const C12_S3A: { id: string; step: number; note: string; expected: ExpectedState }[] = [
  {
    id: 's3a-publish',
    step: 0,
    note: 'vector S3a, block 1 event 0, byte for byte: kind 1 under 0x11…, name "Gold", symbol "GLD", decimals 6, standards "mip-0011": accept',
    expected: { identities: [kind1({ name: 'Gold', symbol: 'GLD', decimals: 6, standards: 'mip-0011' })], groups: S3A_GROUP },
  },
  {
    id: 's3a-delete-name',
    step: 2,
    note: 'vector S3a, block 2, byte for byte: one Null record at name (kind 1 under 0x11…): accept; deletes name only',
    expected: { identities: [kind1({ symbol: 'GLD', decimals: 6, standards: 'mip-0011' })], groups: S3A_GROUP },
  },
];

const U1_DOMAIN = 'mip-0018:example:upgrade';
/** Throwaway signing key (not wallet material) in the signer's state directory, written before the case runs. */
const U1_WRONG_KEY = '/run/mip0018/state/u1-wrong-signer.key';

// ------------------------------------------------------------------------------------------------- rendering

/** The placeholders as the signer on the public network expands them (secrets and state mounted by docker/signer.sh). */
const EXPANSION: Record<string, string[]> = {
  '{net}': ['--network', NETWORK],
  '{signer}': [
    '--mnemonic-file',
    `/run/mip0018/secrets/${NETWORK}-wallet-1.mnemonic`,
    '--wallet-cache',
    '/run/mip0018/state/wallet1.cache',
  ],
  '{signer2}': [
    '--mnemonic-file',
    `/run/mip0018/secrets/${NETWORK}-wallet-2.mnemonic`,
    '--wallet-cache',
    '/run/mip0018/state/wallet2.cache',
    '--private-state',
    '/run/mip0018/state/wallet2-private-state.json',
  ],
};
const quote = (a: string) => (/^[\w@%+=:,./{}-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`);

function render(c: CaseDef, s: Step): string {
  const dir = `${CASES_REL}/${c.id}`;
  const argv = s.argv
    .flatMap((a) => EXPANSION[a] ?? [a])
    .map((a) => a.replace(/\{out:(\w+)\}/gu, `${CASES_REL}/$1`).replace(/\{case\}|\{out\}/gu, dir));
  const cmd = s.script
    ? `docker/run.sh exec ${quote(`node ${s.script} ${argv.map(quote).join(' ')}`)}`
    : `${s.runner === 'signer' ? 'signer' : 'wallet_free'} ${argv.map(quote).join(' ')}`;
  return s.stdout ? `${cmd} > ${dir}/${s.stdout}` : cmd;
}

function readme(c: CaseDef): string {
  const lines = [
    `# ${c.id} — ${c.title}`,
    '',
    `<!-- Generated by deployments/tools/prepare-cases.ts --network ${NETWORK} from the examples' metadata.json and the vectors; do not edit. -->`,
    '',
    `**Demonstrates**: ${c.demonstrates}`,
    '',
    `**Expected conclusion** (from the case definition; consumer states are computed with the reference consumer, never from a chain observation): ${c.conclusion}`,
    '',
    ...(c.dependsOn ? [`**Runs after**: ${c.dependsOn.join(', ')}`, ''] : []),
    ...(c.notes ? [...c.notes.map((n) => `- ${n}`), ''] : []),
    `## Steps (${TITLE})`,
    '',
    `Running the steps writes the run record (\`record.json\`, rendered as the transaction table below) and the observations (\`observed-*.json\`, \`wallet-status.json\`). Shell set-up (bash or zsh; the secret directory holds \`${NETWORK}-wallet-1.mnemonic\` and \`${NETWORK}-wallet-2.mnemonic\` and is mounted read-only into the signer container only${TOKEN_VARIABLE ? `; \`${TOKEN_VARIABLE}\` holds the Blockfrost project token and is passed to the containers by name` : ''}):`,
    '',
    '```sh',
    'signer() {',
    '  MIP0018_SECRET_DIR="<0700 directory holding the wallet mnemonics (0600)>" \\',
    '  MIP0018_STATE_DIR="<0700 state directory outside the repository>" \\',
    '  MIP0018_DOCKER_NETWORK="<Docker network of the proof server>" \\',
    `  MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=<proof server URL on that network>${TOKEN_VARIABLE ? ` -e ${TOKEN_VARIABLE}` : ''}" \\`,
    '  docker/signer.sh mip0018 -- "$@"',
    '}',
    TOKEN_VARIABLE
      ? `wallet_free() { MIP0018_DOCKER_ENV="-e ${TOKEN_VARIABLE}" docker/run.sh mip0018 -- "$@"; }`
      : 'wallet_free() { docker/run.sh mip0018 -- "$@"; }',
    '```',
    '',
    '| # | Step | Wallet | Exit | Command |',
    '|---|---|---|---|---|',
    ...c.steps.map(
      (s, i) =>
        `| ${i + 1} | \`${s.id}\`${s.note ? ` — ${s.note}` : ''} | ${s.wallet ?? 'none'} | ${s.expectExit}${s.expectOutput ? ` (output contains \`${s.expectOutput}\`)` : ''} | \`${render(c, s).replace(/\|/gu, '\\|')}\` |`,
    ),
    '',
    '## Re-check (wallet-free, one command)',
    '',
    '```sh',
    `${TOKEN_VARIABLE ? `MIP0018_DOCKER_ENV="-e ${TOKEN_VARIABLE}" ` : ''}docker/run.sh mip0018 -- recheck --network ${NETWORK} --case ${CASES_REL}/${c.id}`,
    '```',
    '',
    ...recorded(c),
  ];
  return `${lines.join('\n')}\n`;
}

/** Thousands separators for a SPECK amount; ≈ DUST with 3 decimals (1 DUST = 10^15 SPECK). */
const speck = (v: string) => BigInt(v).toLocaleString('en-US');
const dust = (v: string) => (Number(BigInt(v)) / 1e15).toFixed(3);

/**
 * The README's record section: from the case's run record(s) when they exist (public data only), else a placeholder
 * table. Rendering only reads the records, so `--check` stays exact once they are committed.
 */
function recorded(c: CaseDef): string[] {
  const dir = join(CASES, c.id);
  const p = join(dir, 'record.json');
  if (c.id === 'IDX') {
    const st = join(dir, 'index', 'index-state.json');
    if (!existsSync(st)) return ['## Scan', '', 'Not run: no index state yet.', ''];
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
    // which case deployed each contract (from the committed records); any other contract is someone else's
    const caseOf = new Map<string, string>();
    for (const id of readdirSync(CASES).sort()) {
      const rp = join(CASES, id, 'record.json');
      if (!existsSync(rp)) continue;
      const rc = JSON.parse(readFileSync(rp, 'utf8')) as { contract: { address?: string; attached?: unknown } };
      if (rc.contract.address && !rc.contract.attached && !caseOf.has(rc.contract.address)) caseOf.set(rc.contract.address, id);
    }
    return [
      `## Scan (${TITLE})`,
      '',
      `Blocks ${s.fromHeight}–${s.nextHeight - 1} (state \`index/index-state.json\`). Colors minted in that range (the scanner records every mint on the public chain, so a contract that is not one of these cases can appear too):`,
      '',
      '| Case | Color | Contract | domainSep | Shielded (first mint) | Unshielded (first mint) |',
      '|---|---|---|---|---|---|',
      ...Object.entries(s.colors)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([color, e]) =>
            `| ${caseOf.get(e.contractAddress) ?? `not a case (another ${TITLE} contract)`} | \`${color}\` | \`${e.contractAddress}\` | \`${e.domainSep}\` | ${e.shielded ? `${e.shielded.amount} (${e.shielded.firstMint.height})` : '—'} | ${e.unshielded ? `${e.unshielded.amount} (${e.unshielded.firstMint.height})` : '—'} |`,
        ),
      '',
    ];
  }
  if (!existsSync(p))
    return [
      '## Transactions',
      '',
      '| Step | Transaction hash | Block | Fee (SPECK) |',
      '|---|---|---|---|',
      ...c.steps.filter((s) => s.submits).map((s) => `| \`${s.id}\` | — | — | — |`),
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
            ? `not included: ${(/\d{4}: Invalid Transaction[^<]*/u.exec(s.error)?.[0] ?? s.error.split('\n')[0]!).trim().slice(0, 100)}`
            : s.state;
  return [
    `## Transactions (${TITLE}, from \`record.json\`)`,
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
    `# ${TITLE} case folders`,
    '',
    `<!-- Generated by deployments/tools/prepare-cases.ts --network ${NETWORK}; do not edit. -->`,
    '',
    `Each folder holds \`case.json\` (one \`mip0018\` command per step, the exit code each must end with, the re-check list), \`expected.json\` (what the reference consumer must conclude, computed from the examples' metadata.json / the vectors) and \`expect/*.json\` (what \`check-event\` must find per transaction), plus the run record and the observations; \`mip0018 recheck --network ${NETWORK} --case <folder>\` re-checks a case wallet-free.`,
    '',
    '| Case | What | Expected conclusion | Steps | Transactions |',
    '|---|---|---|---:|---:|',
    ...cases.map(
      (c) =>
        `| [${c.id}](${c.id}/README.md) | ${c.title} | ${c.conclusion} | ${c.steps.length} | ${c.steps.filter((s) => s.submits && s.expectExit === 0).length} |`,
    ),
    '',
    `Regenerate: \`docker/run.sh exec 'node deployments/tools/prepare-cases.ts --network ${NETWORK}'\` (\`--check\` in CI).`,
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
          '{net}': `network options (${TITLE}: --network ${NETWORK})`,
          '{signer}': "wallet 1's signer options (mnemonic file, wallet cache)",
          '{signer2}': "wallet 2's signer options, with its OWN private-state file",
          '{case}': 'this case folder',
          '{out}': `where records and observations are written (${TITLE}: this case folder)`,
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

/** Generated files in a case folder (run records and observations are never touched). */
const generated = (rel: string) =>
  /^(case\.json|expected(-after-[\w-]+)?\.json|README\.md|expect\/[\w-]+\.json|args\/[\w-]+\.json)$/u.test(rel);

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}

const check = args.check === true;
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
      if (check) stale.push(`${relative(REPO, p)} (not produced by the generator)`);
      else rmSync(p);
    }
  }
}
if (check && stale.length) {
  process.stderr.write(`stale case files (run node deployments/tools/prepare-cases.ts --network ${NETWORK}):\n  ${stale.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write(`${check ? 'checked' : 'wrote'} ${want.size} files in ${relative(REPO, CASES)}\n`);
