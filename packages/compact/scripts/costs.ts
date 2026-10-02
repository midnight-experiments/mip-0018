// SPDX-License-Identifier: Apache-2.0
//
// Measures every MIP-0018 emitting circuit of the repository and regenerates docs/costs.md
// (between its `costs:begin` / `costs:end` markers) and docs/costs.json:
//
//   * k and rows: `zkir-v3 mock-compile` (Compact 0.35.0, --feature-zkir-v3, full keys);
//   * prover / verifier key sizes and the verifier key's SHA-256 (keys are deterministic, so a
//     rebuild must reproduce them);
//   * proving time on this host: the circuit is executed in compact-runtime 0.20.0 and its proof
//     preimage is proved by the official proof server (`MIP0018_PROOF_SERVER_URL`, e.g. the local
//     stack's 9.0.0-rc.8) PROVE_RUNS times; the median is reported. Skipped when the variable is unset.
//
//   docker/run.sh exec 'node packages/compact/scripts/costs.ts'                       # sizes only
//   MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=http://proof-server:6300" \
//     docker/run.sh exec 'node packages/compact/scripts/costs.ts'                     # + proving times
//   docker/run.sh exec 'node packages/compact/scripts/costs.ts --render'              # re-render docs/costs.md from costs.json

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { ensureCompiled, Simulator } from '../src/testing/index.ts';
import { compileMinimal, witnesses as minimalWitnesses } from '../../../examples/minimal/src/contracts.ts';
import { compileRawEmitter, ownerArg, witnesses as rawWitnesses } from '../../../test-contracts/raw-emitter/src/contract.ts';

const PACKAGE = join(import.meta.dirname, '..');
const REPO = join(PACKAGE, '..', '..');
const PROVE_RUNS = Number(process.env.PROVE_RUNS ?? 3);
const proofServer = process.env.MIP0018_PROOF_SERVER_URL;

const utf8 = (s: string) => new TextEncoder().encode(s);
const DS = new Uint8Array(32).fill(0x11);
const A1 = { name: utf8('Acme Token'), symbol: utf8('ACME'), decimals: 6n, standards: utf8('mip-0004') };
const A1_PAYLOAD = Buffer.from(
  JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', 'A1.json'), 'utf8')).event.payload_hex as string,
  'hex',
);
const NAME = Buffer.from(JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', 'A1.json'), 'utf8')).event.name_hex as string, 'hex');
const SK_A = new Uint8Array(32).fill(0xa1);

type Call = { circuit: string; args?: unknown[]; caller?: Uint8Array; note: string };
type Target = {
  group: string;
  contract: string;
  build: () => string;
  /** Deploy (constructor args may depend on the module, e.g. account ids from pure circuits). */
  deploy: (managed: string) => Promise<Simulator<unknown>>;
  privateState?: (sk: Uint8Array) => unknown;
  calls: Call[];
};

const costsContract = (contract: string, group: string): Target => ({
  group,
  contract,
  build: () =>
    ensureCompiled(join(PACKAGE, 'test', 'contracts', `${contract}.compact`), join(PACKAGE, 'managed', contract), {
      skipZk: false,
      dependsOn: [join(PACKAGE, 'src')],
    }),
  deploy: (m) => Simulator.deploy(m),
  calls: [
    { circuit: 'lit1', note: 'literal: name' },
    { circuit: 'lit2', note: 'literal: name, symbol' },
    { circuit: 'lit3', note: 'literal: name, symbol, decimals (`commonFields`)' },
    { circuit: 'lit4', note: 'literal: + standards (`commonFieldsWithStandards`, A1 shape)' },
    { circuit: 'arg1', args: [DS, A1.name], note: 'runtime domainSep + name' },
    { circuit: 'arg2', args: [DS, A1.name, A1.symbol], note: 'runtime domainSep + name, symbol' },
    { circuit: 'arg3', args: [DS, A1.name, A1.symbol, A1.decimals], note: 'runtime domainSep + 3 common fields' },
    { circuit: 'arg4', args: [DS, A1.name, A1.symbol, A1.decimals, A1.standards], note: 'runtime domainSep + 4 common fields' },
    { circuit: 'dsArg4', args: [DS], note: 'runtime domainSep, literal A1 records' },
    { circuit: 'tombLit', note: 'tombstone, literal header' },
    { circuit: 'tombArg', args: [DS, 3n], note: 'tombstone, runtime domainSep and kind' },
  ],
});

const minimalPs = (sk: Uint8Array) => ({ secretKey: sk });
const minimal = (contract: 'CreateAndDestroy' | 'OwnerKey' | 'PublishOnce', calls: Call[]): Target => ({
  group: 'examples/minimal',
  contract,
  build: () => compileMinimal(contract, { skipZk: false }),
  deploy: async (m) => {
    const probe = await Simulator.deploy(m, {
      witnesses: minimalWitnesses,
      privateState: minimalPs(SK_A),
      args: ctorArgs(contract, new Uint8Array(32)),
    });
    const alice = probe.module.pureCircuits.accountId!(SK_A) as Uint8Array;
    return Simulator.deploy(m, { witnesses: minimalWitnesses, privateState: minimalPs(SK_A), args: ctorArgs(contract, alice) });
  },
  privateState: minimalPs,
  calls,
});
const ctorArgs = (contract: string, account: Uint8Array): unknown[] => (contract === 'OwnerKey' ? [DS, account] : [DS, 1000n, account]);
const BOB_ACCOUNT = new Uint8Array(32).fill(0xbb);

const TARGETS: Target[] = [
  costsContract('CostsTyped', 'typed constructor (default, `Mip0018`)'),
  costsContract('CostsPure', 'pure circuits (alternative, `Mip0018Pure`)'),
  minimal('CreateAndDestroy', [
    { circuit: 'publishMetadata', note: 'unguarded; domainSep read from the sealed ledger field, literal records' },
    { circuit: 'transfer', args: [BOB_ACCOUNT, 1n], note: 'normal operation (no metadata)' },
  ]),
  minimal('OwnerKey', [
    { circuit: 'publishMetadata', note: 'owner check + ledger domainSep, literal records' },
    { circuit: 'setMetadata', args: [utf8('Beta Token'), utf8('BETA')], note: 'owner check + runtime name, symbol' },
    { circuit: 'withdrawMetadata', note: 'owner check + tombstone' },
    { circuit: 'mint', args: [BOB_ACCOUNT, 10n], note: 'normal operation (no metadata)' },
  ]),
  minimal('PublishOnce', [{ circuit: 'publishMetadata', note: 'publish-once flag + ledger domainSep, literal records' }]),
  {
    group: 'test-contracts/raw-emitter (TEST ONLY)',
    contract: 'RawEmitter',
    build: () => compileRawEmitter({ skipZk: false }),
    deploy: async (m) => {
      const probe = await Simulator.deploy(m, {
        witnesses: rawWitnesses,
        privateState: { ownableSecretKey: SK_A },
        args: [ownerArg(new Uint8Array(32).fill(1))],
      });
      const owner = probe.module.pureCircuits.accountId!(SK_A) as Uint8Array;
      return Simulator.deploy(m, { witnesses: rawWitnesses, privateState: { ownableSecretKey: SK_A }, args: [ownerArg(owner)] });
    },
    privateState: (sk) => ({ ownableSecretKey: sk }),
    calls: [
      { circuit: 'emitRaw', args: [NAME, A1_PAYLOAD], note: 'Ownable + runtime name and payload' },
      { circuit: 'emitTwo', args: [NAME, A1_PAYLOAD, NAME, A1_PAYLOAD], note: 'Ownable + two runtime events' },
    ],
  },
];

type Row = {
  group: string;
  contract: string;
  circuit: string;
  note: string;
  k: number;
  rows: number;
  proverKeyBytes: number;
  verifierKeyBytes: number;
  verifierKeySha256: string;
  zkirBytes: number;
  proveMs?: number[];
  proveMedianMs?: number;
};

const mock = (bzkir: string): { k: number; rows: number } => {
  const r = spawnSync('zkir-v3', ['mock-compile', bzkir], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const m = /\(k=(\d+), rows=(\d+)\)/u.exec(out);
  if (!m) throw new Error(`unexpected mock-compile output: ${out}`);
  return { k: Number(m[1]), rows: Number(m[2]) };
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const RENDER_ONLY = process.argv.includes('--render');
const JSON_PATH = join(REPO, 'docs', 'costs.json');

type Meta = {
  measuredAt: string;
  compiler: string;
  language: string;
  zkir: string;
  proofServer: string;
  host: string;
  compileSeconds: Record<string, number>;
};

const measureAll = async (): Promise<{ meta: Meta; rows: Row[] }> => {
  const rows: Row[] = [];
  const compileSeconds: Record<string, number> = {};
  for (const t of TARGETS) {
    const started = Date.now();
    const managed = t.build();
    compileSeconds[t.contract] = Math.round((Date.now() - started) / 1000);
    const circuits = readdirSync(join(managed, 'zkir'))
      .filter((f) => f.endsWith('.bzkir'))
      .map((f) => f.slice(0, -'.bzkir'.length));
    const sim = await t.deploy(managed);
    const prover = proofServer
      ? httpClientProvingProvider(proofServer, new NodeZkConfigProvider<string>(managed), { timeout: 900_000 })
      : undefined;
    for (const call of t.calls) {
      if (!circuits.includes(call.circuit)) throw new Error(`${t.contract} has no circuit ${call.circuit}`);
      const bz = join(managed, 'zkir', `${call.circuit}.bzkir`);
      const vk = readFileSync(join(managed, 'keys', `${call.circuit}.verifier`));
      const row: Row = {
        group: t.group,
        contract: t.contract,
        circuit: call.circuit,
        note: call.note,
        ...mock(bz),
        proverKeyBytes: statSync(join(managed, 'keys', `${call.circuit}.prover`)).size,
        verifierKeyBytes: vk.length,
        verifierKeySha256: createHash('sha256').update(vk).digest('hex'),
        zkirBytes: statSync(bz).size,
      };
      if (t.privateState) sim.currentPrivateState = t.privateState(call.caller ?? SK_A);
      const out = await sim.call(call.circuit, ...(call.args ?? []));
      if (prover && out.proofData) {
        const pd = out.proofData;
        const preimage = proofDataIntoSerializedPreimage(
          pd.input,
          pd.output,
          pd.publicTranscript,
          pd.privateTranscriptOutputs,
          call.circuit,
        );
        row.proveMs = [];
        for (let i = 0; i < PROVE_RUNS; i++) {
          const s = performance.now();
          await prover.prove(preimage, call.circuit, undefined);
          row.proveMs.push(Math.round(performance.now() - s));
        }
        row.proveMedianMs = median(row.proveMs);
      }
      rows.push(row);
      process.stderr.write(
        `${t.contract}.${call.circuit}: k=${row.k} rows=${row.rows}${row.proveMs ? ` prove ${row.proveMs.join('/')} ms` : ''}\n`,
      );
    }
  }
  const info = JSON.parse(readFileSync(join(PACKAGE, 'managed', 'CostsTyped', 'compiler', 'contract-info.json'), 'utf8')) as Record<
    string,
    string
  >;
  const proofVersion = proofServer ? (await (await fetch(`${proofServer}/version`)).text()).trim() : undefined;
  const os = await import('node:os');
  const meta: Meta = {
    measuredAt: new Date().toISOString().slice(0, 10),
    compiler: `${info['compiler-version']} (${String(info['compiler-commit'] ?? '').slice(0, 9)})`,
    language: String(info['language-version']),
    zkir: 'v3 (--feature-zkir-v3)',
    proofServer: proofVersion ? `midnightntwrk/proof-server ${proofVersion} (local, ${PROVE_RUNS} runs, median)` : 'not measured',
    host: `${process.platform}/${process.arch}, ${os.cpus().length} CPUs (${os.cpus()[0]?.model ?? '?'})`,
    compileSeconds,
  };
  writeFileSync(JSON_PATH, `${JSON.stringify({ meta, rows }, null, 2)}\n`);
  // Keep the file in the repository's Prettier style (`npm run lint` checks it).
  const prettier = spawnSync(join(REPO, 'node_modules', '.bin', 'prettier'), ['--write', JSON_PATH], { encoding: 'utf8' });
  if (prettier.status !== 0) throw new Error(`prettier failed: ${prettier.stderr}`);
  return { meta, rows };
};

const { meta, rows } = RENDER_ONLY ? (JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { meta: Meta; rows: Row[] }) : await measureAll();

// --- render ---
const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${(n / 1000).toFixed(1)} kB` : `${n} B`);
const sec = (ms?: number) => (ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const table = (group: string) =>
  [
    '| Contract · circuit | Shape | k | rows | prover key | verifier key | proving (median) |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...rows
      .filter((r) => r.group === group)
      .map(
        (r) =>
          `| \`${r.contract}.${r.circuit}\` | ${r.note} | ${r.k} | ${r.rows.toLocaleString('en-US')} | ${kb(r.proverKeyBytes)} | ${kb(r.verifierKeyBytes)} | ${sec(r.proveMedianMs)} |`,
      ),
  ].join('\n');

const generated = [
  '<!-- costs:begin — generated by `node packages/compact/scripts/costs.ts`; do not edit by hand -->',
  '',
  `Measured ${meta.measuredAt} (UTC): Compact ${meta.compiler}, language ${meta.language}, ZKIR ${meta.zkir}; proving with ${meta.proofServer} on ${meta.host}. Raw numbers, verifier-key SHA-256s and per-run proving times: [\`costs.json\`](costs.json).`,
  '',
  ...[...new Set(rows.map((r) => r.group))].flatMap((g) => [`### ${g}`, '', table(g), '']),
  '<!-- costs:end -->',
].join('\n');

const docPath = join(REPO, 'docs', 'costs.md');
const doc = readFileSync(docPath, 'utf8');
const begin = doc.indexOf('<!-- costs:begin');
const end = doc.indexOf('<!-- costs:end -->');
if (begin < 0 || end < 0) throw new Error('docs/costs.md has no costs:begin / costs:end markers');
writeFileSync(docPath, `${doc.slice(0, begin)}${generated}${doc.slice(end + '<!-- costs:end -->'.length)}`);
process.stderr.write(`wrote docs/costs.md and docs/costs.json (${rows.length} circuits)\n`);
