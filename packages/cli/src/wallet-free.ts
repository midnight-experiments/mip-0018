// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free commands: verify, list, index, lookup, vectors run. None of them reads a secret.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  compareState,
  expectedStateFrom,
  listMetadata,
  loadState,
  lookupColor,
  normAddress,
  projectState,
  reduceScannedEvents,
  scan,
  statePath,
  tokenTypeHex,
  verifyEmission,
  type EventExpectation,
  type ListReport,
  type VerifyReport,
} from '@mip0018/midnight';
import { formatAmount, type IdentityView } from '@mip0018/consumer';
import {
  EXIT,
  KIND_NAME,
  NETWORK_OPTIONS,
  UsageError,
  emitJson,
  int,
  jsonArg,
  kv,
  logger,
  out,
  parse,
  profileFrom,
  readRecord,
  recordContract,
  recordStep,
  repoRoot,
  short,
  str,
} from './common.ts';

// ---------------------------------------------------------------------------------------------------------- verify

export const VERIFY_USAGE = `
mip0018 verify --network <stagenet|undeployed> (--contract <address> --tx <hash> | --record <file> [--step <id>]) [options]

Checks one emission without a wallet: the contract's Misc event(s) in that transaction (indexer), the event name,
the contract address from the event record, the decoded payload (accept / reject / ignore with the reason), the raw
transaction (hash, identifiers, the same bytes in a log op of the contract, zero-extended to 288), the node's block
hash, finality and the raw bytes inside the block's extrinsic.

  --expect <json|@file>   expectation per event (object = the only event, array = per event in order):
                          {"metadata": {"domainSep","kind","name","symbol","decimals","standards"}} | {"payload": hex}
                          | {"result": "accept|reject|ignore", "reason": …} | {"records": [...]} | {"domainSep","kind"}
  --record <file>         take the contract address and the transaction from a run record (public JSON)
  --step <id>             the record's step (default: its only call step that logged events)
  --wait <seconds>        keep polling the indexer for the transaction (default 0)
  --no-extrinsic-check    skip chain_getBlock
  --json                  JSON report
  undeployed: --indexer <url> --rpc <url> (or MIP0018_INDEXER_URL / MIP0018_NODE_URL) [--genesis <hash>]

Exit: 0 ok · 1 mismatch · 2 usage · 3 not found · 4 not yet indexed / final
`;

function recordsText(rs: unknown[] | undefined): string {
  return (rs ?? [])
    .map((r) => {
      const x = r as { keyText: string; valType: number; value: string; integer?: string };
      const v = Buffer.from(x.value, 'hex');
      const shown =
        x.valType === 2
          ? x.integer
          : x.valType === 5
            ? '<tombstone>'
            : x.valType === 0
              ? `0x${x.value}`
              : JSON.stringify(v.toString('utf8'));
      return `${x.keyText}=${shown}`;
    })
    .join(' ');
}

export function printVerify(r: VerifyReport): void {
  kv([
    ['network', `${r.network.id}  genesis ${short(r.network.genesisHash, 6)}  indexer ${r.network.indexer}`],
    ['contract', r.contract],
    [
      'transaction',
      r.inclusion
        ? `${r.transaction}  block ${r.inclusion.height} (${short(r.inclusion.hash)})  ${r.inclusion.status ?? '?'}  ${r.inclusion.finalized ? 'finalized' : 'NOT finalized'} (finalized head ${r.inclusion.finalizedHeight})${r.inclusion.extrinsicIndex !== undefined && r.inclusion.extrinsicIndex >= 0 ? `  extrinsic ${r.inclusion.extrinsicIndex}` : ''}`
        : r.transaction,
    ],
  ]);
  for (const e of r.events) {
    const seg = e.source
      ? `segment ${e.source.physicalSegment} (${e.source.logicalSegment === 0 ? 'guaranteed' : `fallible ${e.source.logicalSegment}`})  entry ${e.source.entryPoint ?? '?'}`
      : '';
    kv([[`event ${e.index}`, `id ${e.id}  ${seg}`]]);
    const c = e.classification;
    const res =
      c.result === 'accept'
        ? `accept  domainSep ${c.domainSep}  kind ${c.kind} (${KIND_NAME[c.kind!] ?? '?'})`
        : `${c.result}  reason ${c.reason}${c.offset !== undefined ? ` at offset ${c.offset}` : ''}`;
    kv([['  result', res]]);
    if (c.result === 'accept') kv([['  records', recordsText(c.records)]]);
    if (e.expectation) kv([['  expected', e.expectation.ok ? 'matches' : `DIFFERS: ${e.expectation.differences.join('; ')}`]]);
  }
  out('checks');
  for (const c of r.checks) out(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.id.padEnd(20)} ${c.message}`);
  for (const n of r.notes) out(`  note ${n}`);
  kv([['result', `${r.outcome} (exit ${r.exitCode})`]]);
}

export async function cmdVerify(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...NETWORK_OPTIONS,
      contract: { type: 'string' },
      tx: { type: 'string' },
      record: { type: 'string' },
      step: { type: 'string' },
      expect: { type: 'string' },
      wait: { type: 'string' },
      'no-extrinsic-check': { type: 'boolean', default: false },
    },
    VERIFY_USAGE,
  );
  const profile = profileFrom(v);
  let contract = str(v, 'contract');
  let tx = str(v, 'tx');
  const recordPath = str(v, 'record');
  if (recordPath !== undefined) {
    if (contract !== undefined || tx !== undefined) throw new UsageError('--record excludes --contract and --tx');
    const r = readRecord(recordPath);
    contract = recordContract(r, profile);
    tx = recordStep(r, str(v, 'step')).tx;
  } else if (str(v, 'step') !== undefined) throw new UsageError('--step needs --record');
  if (contract === undefined) throw new UsageError('--contract (or --record) is required');
  if (tx === undefined) throw new UsageError('--tx (or --record) is required');
  const expect = jsonArg(v, 'expect') as EventExpectation | EventExpectation[] | undefined;
  const r = await verifyEmission({
    profile,
    contract,
    tx,
    expect,
    waitMs: (int(v, 'wait') ?? 0) * 1000,
    extrinsicCheck: !v['no-extrinsic-check'],
  });
  if (v.json) emitJson(r);
  else printVerify(r);
  return r.exitCode;
}

// ------------------------------------------------------------------------------------------------------------ list

export const LIST_USAGE = `
mip0018 list --network <stagenet|undeployed> (--contract <address> | --record <file>) [options]

Every MIP-0018 event of a contract in chain order and the current metadata per token identity (reference consumer):
visibility, fields (usable or not), color for kinds 1 and 2, symbol groups and the source events. Pages the indexer
until an empty page; refuses rather than truncates. The indexer serves finalized blocks only, so the state is the
finalized one (--finalized is accepted and always true).

  --record <file>       the contract of a run record
  --expect <json|@file> the expected state (identities, groups[, counts]) or a metadata.json (its "expected"):
                        compared by (domainSep, kind); exit 1 with the differences when it does not match
  --to-block <height>   state as of that block (inclusive)
  --history             also show replaced values (marked history)
  --max-events <n>      refuse above n events (default 100000)
  --json                JSON report

Exit: 0 ok · 1 the indexer tip differs from the node, or --expect does not match · 2 usage
`;

function fieldText(f: IdentityView['fields'][number]): string {
  const v = Buffer.from(f.value);
  if (f.valType === 2) return f.integer?.toString() ?? `0x${v.toString('hex')}`;
  if (f.valType === 0) return `0x${v.toString('hex')}`;
  return JSON.stringify(v.toString('utf8'));
}

export function printIdentity(id: IdentityView, indent = ''): void {
  out(
    `${indent}identity  domainSep ${id.domainSep}  kind ${id.kind} (${KIND_NAME[id.kind] ?? '?'})  ${id.visible ? 'visible' : 'HIDDEN (withdrawn)'}  color ${id.color ? Buffer.from(id.color).toString('hex') : '-'}`,
  );
  for (const f of id.fields) {
    const key = Buffer.from(f.key).toString('utf8');
    out(
      `${indent}  ${key.padEnd(12)} ${fieldText(f).padEnd(40)} type ${f.valType}${f.usable === undefined ? '' : f.usable ? '  usable' : '  UNUSABLE'}`,
    );
  }
  if (id.common.decimals !== undefined)
    out(`${indent}  display      1 base unit = ${formatAmount(1n, id.common.decimals)} ${id.common.symbol ?? ''}`.trimEnd());
}

export function printList(r: ListReport): void {
  kv([
    ['contract', `${r.contract}  network ${r.network.id}`],
    [
      'snapshot',
      `indexer block ${r.snapshot.indexerTip.height} (${short(r.snapshot.indexerTip.hash)})${r.snapshot.tipMatchesNode ? ' = node' : ' ≠ NODE'}  to-block ${r.snapshot.toBlock}  node finalized ${r.snapshot.finalizedHeight}`,
    ],
    [
      'events',
      `${r.counts.events} (${r.counts.accepted} accepted, ${r.counts.rejected} rejected, ${r.counts.ignored} ignored) in ${r.pages} page(s)`,
    ],
  ]);
  for (const id of r.identities) printIdentity(id);
  if (r.groups.length) {
    out('groups');
    for (const g of r.groups)
      out(
        `  ${JSON.stringify(Buffer.from(g.symbol).toString('utf8'))}: ${g.members.map((m) => `${short(m.domainSep, 4)}/${m.kind}`).join(', ')}`,
      );
  }
  if (r.history) {
    out('history (replaced values; never current)');
    for (const [k, h] of Object.entries(r.history))
      for (const [key, entries] of Object.entries(h))
        out(`  ${short(k, 10)} ${Buffer.from(key, 'hex').toString('utf8')}: ${entries.length} earlier value(s)`);
  }
  out('source events');
  for (const e of r.events)
    out(
      `  ${String(e.id).padEnd(8)} block ${String(e.block.height).padEnd(8)} tx ${short(e.txHash)}  ${e.result.padEnd(6)} ${e.result === 'accept' ? `${short(e.domainSep ?? '', 4)}/${e.kind} (${e.records} record(s))` : e.reason}`,
    );
}

export async function cmdList(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...NETWORK_OPTIONS,
      contract: { type: 'string' },
      record: { type: 'string' },
      expect: { type: 'string' },
      'to-block': { type: 'string' },
      history: { type: 'boolean', default: false },
      'max-events': { type: 'string' },
      finalized: { type: 'boolean', default: true },
    },
    LIST_USAGE,
  );
  const profile = profileFrom(v);
  let contract = str(v, 'contract');
  const recordPath = str(v, 'record');
  if (recordPath !== undefined) {
    if (contract !== undefined) throw new UsageError('--record excludes --contract');
    contract = recordContract(readRecord(recordPath), profile);
  }
  if (contract === undefined) throw new UsageError('--contract (or --record) is required');
  const expectJson = jsonArg(v, 'expect');
  let expected;
  try {
    expected = expectJson === undefined ? undefined : expectedStateFrom(expectJson);
  } catch (e) {
    throw new UsageError(`--expect: ${(e as Error).message}`);
  }
  const r = await listMetadata({
    profile,
    contract,
    toBlock: int(v, 'to-block'),
    history: v.history === true,
    maxEvents: int(v, 'max-events'),
  });
  const expectation = expected ? compareState(projectState(r.identities, r.groups, r.counts), expected) : undefined;
  if (v.json) emitJson(expectation ? { ...r, expectation } : r);
  else {
    printList(r);
    if (expectation) kv([['expected', expectation.ok ? 'matches' : `DIFFERS:\n  ${expectation.differences.join('\n  ')}`]]);
  }
  if (!r.snapshot.tipMatchesNode) return EXIT.failed;
  return expectation && !expectation.ok ? EXIT.failed : EXIT.ok;
}

// ----------------------------------------------------------------------------------------------------------- index

export const INDEX_USAGE = `
mip0018 index --network <stagenet|undeployed> --from-height <h> [--to-height <h> | --follow] --state <dir> [options]

The reference mint scanner: reads every block from the start height (indexer \`blocks\` subscription; polling
\`block(offset:{height})\` as the fallback or with --poll), decodes each contract call's raw transaction with
ledger-v9 and, for the parts that took effect, records shielded/unshielded mints as
color = tokenType(domainSep, contract) → (contract, domainSep, kinds minted, first mint), plus every MIP-0018 event.
Checkpoint after every block (<state>/index-state.json, atomic); re-run the same command to resume.
Stagenet: start near the deployments (public endpoints; requests are rate-bounded). Local chain: start at 0 or 1.

  --to-height <h>   last height (default: the indexer tip when the scan starts)
  --follow          keep following new blocks (Ctrl-C to stop; resumable)
  --poll            no WebSocket subscription
  --json            final state summary as JSON
`;

export async function cmdIndex(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...NETWORK_OPTIONS,
      'from-height': { type: 'string' },
      'to-height': { type: 'string' },
      follow: { type: 'boolean', default: false },
      state: { type: 'string' },
      poll: { type: 'boolean', default: false },
    },
    INDEX_USAGE,
  );
  const profile = profileFrom(v);
  const from = int(v, 'from-height', true)!;
  const to = int(v, 'to-height');
  if (v.follow && to !== undefined) throw new UsageError('--follow and --to-height exclude each other');
  const stateDir = str(v, 'state', true)!;
  const log = logger(v);
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const crash = process.env.MIP0018_TEST_SCAN_CRASH_AFTER_BLOCKS;
  let last = Date.now();
  const r = await scan({
    profile,
    stateDir,
    fromHeight: from,
    toHeight: to,
    follow: v.follow === true,
    poll: v.poll === true,
    signal: ac.signal,
    log,
    ...(crash ? { crashAfterBlocks: Number(crash) } : {}),
    onBlock: (s, b, d) => {
      if (d.mints || d.events) log(`block ${b.height}: ${d.mints} mint(s), ${d.events} MIP-0018 event(s)`);
      else if (Date.now() - last > 10_000) {
        last = Date.now();
        log(`block ${b.height} (${s.stats.blocks} scanned, ${Object.keys(s.colors).length} colors)`);
      }
    },
  });
  const s = r.state;
  if (v.json)
    emitJson({ mode: r.mode, blocksThisRun: r.blocksThisRun, requests: r.requests, seconds: r.seconds, state: statePath(stateDir), ...s });
  else {
    kv([
      ['network', `${s.network.id}  genesis ${short(s.network.genesisHash, 6)}`],
      [
        'range',
        `${s.fromHeight} .. ${s.nextHeight - 1}  (${r.blocksThisRun} block(s) this run, ${r.mode}, ${r.requests} HTTP request(s), ${r.seconds} s)`,
      ],
      [
        'scanned',
        `${s.stats.blocks} blocks, ${s.stats.transactions} transactions, ${s.stats.contractCalls} contract calls, ${s.stats.decodeErrors} decode errors`,
      ],
      ['state', statePath(stateDir)],
    ]);
    out(`colors (${Object.keys(s.colors).length})`);
    for (const c of Object.values(s.colors)) {
      const kinds = [
        c.shielded ? `shielded ×${c.shielded.mints} (first ${c.shielded.firstMint.height})` : '',
        c.unshielded ? `unshielded ×${c.unshielded.mints} (first ${c.unshielded.firstMint.height})` : '',
      ]
        .filter(Boolean)
        .join(', ');
      out(`  ${c.color}  contract ${short(c.contractAddress)}  domainSep ${short(c.domainSep, 6)}  ${kinds}`);
    }
    out(`deploys (${s.stats.deploys})`);
    for (const [addr, d] of Object.entries(s.deploys)) out(`  ${addr}  block ${d.height}  tx ${short(d.txHash)}`);
    out(`MIP-0018 events (${s.stats.events})`);
    for (const [addr, evs] of Object.entries(s.events))
      out(`  ${addr}: ${evs.length} (${evs.filter((e) => e.result === 'accept').length} accepted)`);
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------------------------------------------------- lookup

export const LOOKUP_USAGE = `
mip0018 lookup (--color <hex> | (--contract <address> | --record <file>) --domain-sep <hex>) --state <dir>
               [--kind 1|2] [--network <id> …] [--json]

Resolves a color (the 32-byte token type of a shielded coin or unshielded UTXO) through the scanner's table to the
token identity (contract, domainSep, kind) and its current metadata: live from the indexer when --network is given
(the contract's whole history), otherwise from the MIP-0018 events the scan recorded (scanned range only).
Kind 3 (ledger tokens) has no color: list the contract's kind-3 events with \`mip0018 list\` instead.
With --contract/--record and --domain-sep the color is computed (tokenType(domainSep, contract)) and looked up:
the table must hold exactly that contract and domainSep for it.

Exit: 0 resolved · 2 usage (e.g. --kind 3) · 3 not minted in the scanned range
`;

export async function cmdLookup(argv: string[]): Promise<number> {
  const v = parse(
    argv,
    {
      ...NETWORK_OPTIONS,
      color: { type: 'string' },
      contract: { type: 'string' },
      record: { type: 'string' },
      'domain-sep': { type: 'string' },
      state: { type: 'string' },
      kind: { type: 'string' },
    },
    LOOKUP_USAGE,
  );
  const kindArg = int(v, 'kind');
  if (kindArg === 3)
    throw new UsageError('kind 3 (ledger token) has no color; query the contract with `mip0018 list --contract <address>`');
  if (kindArg !== undefined && kindArg !== 1 && kindArg !== 2) throw new UsageError('--kind is 1 (shielded coin) or 2 (unshielded UTXO)');
  const stateDir = str(v, 'state', true)!;
  const s = loadState(stateDir);
  if (!s) throw new UsageError(`no index state in ${stateDir} (run mip0018 index first)`);
  let color = str(v, 'color');
  let computedFrom: { contract: string; domainSep: string } | undefined;
  const ds = str(v, 'domain-sep');
  if (ds !== undefined) {
    if (color !== undefined) throw new UsageError('--domain-sep computes the color: drop --color');
    let contract = str(v, 'contract');
    const recordPath = str(v, 'record');
    if (recordPath !== undefined) {
      const rec = readRecord(recordPath);
      if (rec.network.id !== s.network.id)
        throw new UsageError(`${recordPath} is for ${rec.network.id}; the index state for ${s.network.id}`);
      if (!rec.contract.address) throw new UsageError(`${recordPath} has no contract address`);
      contract = rec.contract.address;
    }
    if (contract === undefined) throw new UsageError('--domain-sep needs --contract or --record');
    try {
      color = tokenTypeHex(ds, contract);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    computedFrom = { contract: normAddress(contract), domainSep: ds.replace(/^0x/u, '').toLowerCase() };
  }
  if (color === undefined) throw new UsageError('--color (or --contract/--record with --domain-sep) is required');
  const r = lookupColor(s, color, kindArg as 1 | 2 | undefined);
  if (r.found && computedFrom && (r.entry!.contractAddress !== computedFrom.contract || r.entry!.domainSep !== computedFrom.domainSep)) {
    process.stderr.write(
      `mip0018: the table maps ${color} to ${r.entry!.contractAddress}/${r.entry!.domainSep}, not ${computedFrom.contract}/${computedFrom.domainSep}\n`,
    );
    return EXIT.failed;
  }
  if (!r.found) {
    if (v.json) emitJson(r);
    else out(`color ${r.color} was not minted in the scanned range [${r.scanned.from}, ${r.scanned.to}] of ${r.scanned.network}`);
    return EXIT.notFound;
  }
  const live = str(v, 'network') !== undefined;
  let identities: IdentityView[];
  let source: string;
  if (live) {
    const profile = profileFrom(v);
    if (profile.id !== s.network.id) throw new UsageError(`the index state is for ${s.network.id}, not ${profile.id}`);
    const l = await listMetadata({ profile, contract: r.entry!.contractAddress });
    identities = l.identities;
    source = `live indexer at block ${l.snapshot.indexerTip.height}`;
  } else {
    identities = reduceScannedEvents(s.network.id, r.entry!.contractAddress, s.events[r.entry!.contractAddress] ?? []).identities();
    source = `scanned range [${r.scanned.from}, ${r.scanned.to}] only`;
  }
  const resolved = r.identities.map((i) => ({
    ...i,
    metadata: identities.find((x) => x.domainSep === i.domainSep && x.kind === i.kind) ?? null,
  }));
  if (v.json) emitJson({ ...r, metadataSource: source, resolved });
  else {
    kv([
      ['color', r.color],
      ['table', `contract ${r.entry!.contractAddress}  domainSep ${r.entry!.domainSep}`],
      [
        'minted',
        [
          r.entry!.shielded ? `shielded ×${r.entry!.shielded.mints} first at ${r.entry!.shielded.firstMint.height}` : '',
          r.entry!.unshielded ? `unshielded ×${r.entry!.unshielded.mints} first at ${r.entry!.unshielded.firstMint.height}` : '',
        ]
          .filter(Boolean)
          .join('; '),
      ],
      ['metadata', source],
    ]);
    for (const i of resolved) {
      if (i.metadata) printIdentity(i.metadata, '  ');
      else out(`  identity  kind ${i.kind} (${KIND_NAME[i.kind]}): no MIP-0018 metadata published`);
    }
  }
  return EXIT.ok;
}

// --------------------------------------------------------------------------------------------------------- vectors

export const VECTORS_USAGE = `
mip0018 vectors run [--consumer "<command>"] [runner options]

Runs the language-neutral vectors (vectors/tools/run.ts) against a consumer that implements the runner contract
(vectors/README.md). Default consumer: the reference adapter (node packages/consumer/bin/vector-adapter.js).
Other options (--only, --normative-only, --notes, --json <file>, --timeout, --no-verify) are passed through.
`;

export function cmdVectors(argv: string[]): number {
  if (argv[0] !== 'run') throw new UsageError(VECTORS_USAGE.trim());
  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    out(VECTORS_USAGE.trim());
    return EXIT.ok;
  }
  const root = repoRoot();
  const args = rest.includes('--consumer')
    ? rest
    : ['--consumer', `node ${join(root, 'packages', 'consumer', 'bin', 'vector-adapter.js')}`, ...rest];
  const r = spawnSync(process.execPath, [join(root, 'vectors', 'tools', 'run.ts'), ...args], { stdio: 'inherit', env: process.env });
  return r.status ?? EXIT.failed;
}
