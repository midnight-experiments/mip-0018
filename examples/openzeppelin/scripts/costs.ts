// SPDX-License-Identifier: Apache-2.0
//
// Measures every deployed circuit of the five OpenZeppelin examples (the MIP-0018 circuits and the
// token's own ones, for comparison) and regenerates examples/openzeppelin/costs.json and the costs
// table of examples/openzeppelin/README.md (between `oz-costs:begin` / `oz-costs:end`):
//
//   * k and rows: `zkir-v3 mock-compile` (Compact 0.35.0, --feature-zkir-v3, full keys);
//   * prover / verifier key sizes and the verifier key's SHA-256 (keys are deterministic: a deploy
//     of the same source must carry exactly these verifier keys);
//   * proving time on this host: each circuit is executed in compact-runtime 0.20.0 and its proof
//     preimage proved by the official proof server (`MIP0018_PROOF_SERVER_URL`) PROVE_RUNS times
//     (median). Skipped when the variable is unset.
//
//   docker/run.sh exec 'node examples/openzeppelin/scripts/costs.ts'            # sizes only
//   MIP0018_DOCKER_NETWORK=<network with a proof server> \
//   MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=http://<proof server>:6300" \
//     docker/run.sh exec 'node examples/openzeppelin/scripts/costs.ts'          # + proving times
//   docker/run.sh exec 'node examples/openzeppelin/scripts/costs.ts --render'   # re-render from costs.json
//
// The same method as packages/compact/scripts/costs.ts (docs/costs.md), which measures the module
// itself, examples/minimal and the raw emitter.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { fromHex } from '@mip0018/codec';
import { compileExample, EXAMPLE_NAMES, EXAMPLES, OZ_DIR, REPO, type ExampleName } from '../src/examples.ts';
import { account, accountId, callAs, coinPublicKey, deployAs, exampleAddress, loadMetadata, utf8 } from '../src/testing.ts';

const PROVE_RUNS = Number(process.env.PROVE_RUNS ?? 3);
const proofServer = process.env.MIP0018_PROOF_SERVER_URL;
const RENDER_ONLY = process.argv.includes('--render');
const JSON_PATH = join(OZ_DIR, 'costs.json');
const README = join(OZ_DIR, 'README.md');

const OWNER = new Uint8Array(32).fill(0x0a);
const HOLDER = new Uint8Array(32).fill(0x0b);
const CPK = coinPublicKey(new Uint8Array(32).fill(0xb1));
const USER = { bytes: new Uint8Array(32).fill(0xb2) };
const NONCE = new Uint8Array(32).fill(0x01);
const MIP0018_CIRCUITS = new Set(['publishMetadata', 'setMetadata', 'withdrawMetadata']);

type Call = { circuit: string; args?: (results: Map<string, unknown>) => unknown[]; caller?: Uint8Array; note: string };

const ctorArgs = (example: ExampleName): unknown[] => {
  const c = loadMetadata(example).contract.constructorArgs as Record<string, unknown>;
  const tail = [c.name_, c.symbol_, BigInt(c.decimals_ as number), account(accountId(OWNER))];
  return typeof c.domainSep === 'string' ? [fromHex(c.domainSep), ...tail] : tail;
};
const domainOf = (example: ExampleName) => fromHex(loadMetadata(example).identities[0]!.domainSep);

const CALLS: Record<ExampleName, Call[]> = {
  'fungible-token': [
    { circuit: 'publishMetadata', note: 'MIP-0018: owner + constant domainSep, literal name/symbol, `decimals` from state' },
    { circuit: 'setMetadata', args: () => [utf8('Acme Bars'), utf8('ABAR')], note: 'MIP-0018: owner + runtime name (9 B), symbol (4 B)' },
    { circuit: 'withdrawMetadata', note: 'MIP-0018: owner + `withdraw` (four Null records)' },
    { circuit: 'mint', args: () => [account(accountId(HOLDER)), 1000n], note: 'token: owner mint' },
    { circuit: 'transfer', args: () => [account(accountId(OWNER)), 1n], caller: HOLDER, note: 'token: transfer' },
    { circuit: 'burn', args: () => [account(accountId(HOLDER)), 1n], note: 'token: owner burn' },
    { circuit: 'balanceOf', args: () => [account(accountId(HOLDER))], note: 'token: getter' },
    { circuit: 'name', note: 'token: getter' },
    { circuit: 'symbol', note: 'token: getter' },
    { circuit: 'decimals', note: 'token: getter' },
  ],
  'native-shielded': [
    { circuit: 'publishMetadata', note: 'MIP-0018: owner + `NativeShieldedToken__domain`, literal name/symbol, `decimals` from state' },
    {
      circuit: 'setMetadata',
      args: () => [utf8('Acme Secret'), utf8('ASEC')],
      note: 'MIP-0018: owner + runtime name (11 B), symbol (4 B)',
    },
    { circuit: 'withdrawMetadata', note: 'MIP-0018: owner + `withdraw` (four Null records)' },
    { circuit: 'mint', args: () => [CPK, 1000n, NONCE], note: 'token: owner mint (shielded coin)' },
    { circuit: 'burn', args: (r) => [r.get('mint'), 400n, CPK], note: 'token: owner burn of a coin paid in' },
    { circuit: 'tokenColor', note: 'token: getter' },
    { circuit: 'name', note: 'token: getter' },
    { circuit: 'symbol', note: 'token: getter' },
    { circuit: 'decimals', note: 'token: getter' },
  ],
  'native-unshielded': [
    { circuit: 'publishMetadata', note: 'MIP-0018: owner + `_domain`, literal name/symbol, `decimals` from state' },
    {
      circuit: 'setMetadata',
      args: () => [utf8('Acme Opened'), utf8('AOPN')],
      note: 'MIP-0018: owner + runtime name (11 B), symbol (4 B)',
    },
    { circuit: 'withdrawMetadata', note: 'MIP-0018: owner + `withdraw` (four Null records)' },
    { circuit: 'mint', args: () => [USER, 1000n], note: 'token: owner mint (unshielded UTXO)' },
    { circuit: 'tokenColor', note: 'token: getter' },
    { circuit: 'name', note: 'token: getter' },
    { circuit: 'symbol', note: 'token: getter' },
    { circuit: 'decimals', note: 'token: getter' },
  ],
  'multi-kind': [
    { circuit: 'publishMetadata', note: 'MIP-0018: owner + three events (kinds 1, 2, 3), ledger domainSep and decimals' },
    {
      circuit: 'setMetadata',
      args: () => [3n, utf8('Acme Ledger'), utf8('ACL')],
      note: 'MIP-0018: owner + runtime kind, name (11 B), symbol (3 B)',
    },
    { circuit: 'withdrawMetadata', args: () => [2n], note: 'MIP-0018: owner + `withdraw` (four Null records), runtime kind' },
    { circuit: 'mintShielded', args: () => [CPK, 10n, NONCE], note: 'token: owner mint (shielded coin)' },
    { circuit: 'mintUnshielded', args: () => [USER, 10n], note: 'token: owner mint (unshielded UTXO)' },
    { circuit: 'mintLedger', args: () => [account(accountId(HOLDER)), 10n], note: 'token: owner mint (ledger balance)' },
    { circuit: 'transfer', args: () => [account(accountId(OWNER)), 1n], caller: HOLDER, note: 'token: ledger transfer' },
    { circuit: 'balanceOf', args: () => [account(accountId(HOLDER))], note: 'token: getter' },
  ],
  'token-family': [
    {
      circuit: 'publishMetadata',
      args: () => [domainOf('token-family')],
      note: 'MIP-0018: owner + runtime domain, literal name/symbol, `decimals` from state',
    },
    {
      circuit: 'setMetadata',
      args: () => [domainOf('token-family'), utf8('Gold Medals'), utf8('GOLDM')],
      note: 'MIP-0018: owner + runtime domain, name (11 B), symbol (5 B)',
    },
    {
      circuit: 'withdrawMetadata',
      args: () => [domainOf('token-family')],
      note: 'MIP-0018: owner + `withdraw` (four Null records), runtime domain',
    },
    { circuit: 'mint', args: () => [domainOf('token-family'), CPK, 10n, NONCE], note: 'token: owner mint (shielded coin of one type)' },
    { circuit: 'tokenColor', args: () => [domainOf('token-family')], note: 'token: getter' },
    { circuit: 'name', note: 'token: getter' },
    { circuit: 'symbol', note: 'token: getter' },
    { circuit: 'decimals', note: 'token: getter' },
  ],
};

type Row = {
  example: ExampleName;
  contract: string;
  circuit: string;
  mip0018: boolean;
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
type Meta = {
  measuredAt: string;
  compiler: string;
  language: string;
  zkir: string;
  openzeppelin: string;
  proofServer: string;
  host: string;
};

const mock = (bzkir: string): { k: number; rows: number } => {
  const r = spawnSync('zkir-v3', ['mock-compile', bzkir], { encoding: 'utf8' });
  const m = /\(k=(\d+), rows=(\d+)\)/u.exec(`${r.stdout}${r.stderr}`);
  if (!m) throw new Error(`unexpected mock-compile output: ${r.stdout}${r.stderr}`);
  return { k: Number(m[1]), rows: Number(m[2]) };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const measureAll = async (): Promise<{ meta: Meta; rows: Row[] }> => {
  const rows: Row[] = [];
  let info: Record<string, string> = {};
  for (const example of EXAMPLE_NAMES) {
    const t = Date.now();
    const managed = compileExample(example, { skipZk: false });
    process.stderr.write(`${example}: full keys in ${Math.round((Date.now() - t) / 1000)} s\n`);
    info = JSON.parse(readFileSync(join(managed, 'compiler', 'contract-info.json'), 'utf8')) as Record<string, string>;
    const deployed = readdirSync(join(managed, 'zkir'))
      .filter((f) => f.endsWith('.bzkir'))
      .map((f) => f.slice(0, -'.bzkir'.length));
    const calls = CALLS[example];
    const missing = deployed.filter((c) => !calls.some((x) => x.circuit === c));
    if (missing.length > 0) throw new Error(`${example}: no measurement call for ${missing.join(', ')}`);
    const sim = await deployAs(managed, OWNER, ctorArgs(example), exampleAddress(example));
    const prover = proofServer
      ? httpClientProvingProvider(proofServer, new NodeZkConfigProvider<string>(managed), { timeout: 900_000 })
      : undefined;
    const results = new Map<string, unknown>();
    for (const call of calls) {
      const bz = join(managed, 'zkir', `${call.circuit}.bzkir`);
      const vk = readFileSync(join(managed, 'keys', `${call.circuit}.verifier`));
      const row: Row = {
        example,
        contract: EXAMPLES[example].contract,
        circuit: call.circuit,
        mip0018: MIP0018_CIRCUITS.has(call.circuit),
        note: call.note,
        ...mock(bz),
        proverKeyBytes: statSync(join(managed, 'keys', `${call.circuit}.prover`)).size,
        verifierKeyBytes: vk.length,
        verifierKeySha256: createHash('sha256').update(vk).digest('hex'),
        zkirBytes: statSync(bz).size,
      };
      const out = await callAs(sim, call.caller ?? OWNER, call.circuit, ...(call.args?.(results) ?? []));
      results.set(call.circuit, out.result);
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
      process.stderr.write(`  ${call.circuit}: k=${row.k} rows=${row.rows}${row.proveMs ? ` prove ${row.proveMs.join('/')} ms` : ''}\n`);
    }
  }
  const proofVersion = proofServer ? (await (await fetch(`${proofServer}/version`)).text()).trim() : undefined;
  const os = await import('node:os');
  const ozVersion = (
    JSON.parse(readFileSync(join(REPO, 'node_modules', '@openzeppelin', 'compact-contracts', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const meta: Meta = {
    measuredAt: new Date().toISOString().slice(0, 10),
    compiler: `${info['compiler-version']} (${String(info['compiler-commit'] ?? '').slice(0, 9)})`,
    language: String(info['language-version']),
    zkir: 'v3 (--feature-zkir-v3)',
    openzeppelin: `@openzeppelin/compact-contracts@${ozVersion}`,
    proofServer: proofVersion ? `midnightntwrk/proof-server ${proofVersion} (local, ${PROVE_RUNS} runs, median)` : 'not measured',
    host: `${process.platform}/${process.arch}, ${os.cpus().length} CPUs (${os.cpus()[0]?.model ?? '?'})`,
  };
  writeFileSync(JSON_PATH, `${JSON.stringify({ meta, rows }, null, 2)}\n`);
  const prettier = spawnSync(join(REPO, 'node_modules', '.bin', 'prettier'), ['--write', JSON_PATH], { encoding: 'utf8' });
  if (prettier.status !== 0) throw new Error(`prettier failed: ${prettier.stderr}`);
  return { meta, rows };
};

const { meta, rows } = RENDER_ONLY ? (JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { meta: Meta; rows: Row[] }) : await measureAll();

const size = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${(n / 1000).toFixed(1)} kB` : `${n} B`);
const sec = (ms?: number) => (ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const generated = [
  '<!-- oz-costs:begin — generated by `node examples/openzeppelin/scripts/costs.ts`; do not edit by hand -->',
  '',
  `Measured ${meta.measuredAt} (UTC): Compact ${meta.compiler}, language ${meta.language}, ZKIR ${meta.zkir}, ${meta.openzeppelin}; proving with ${meta.proofServer} on ${meta.host}. Verifier-key SHA-256s and per-run proving times: [\`costs.json\`](costs.json).`,
  '',
  '| Example · circuit | What | k | rows | prover key | verifier key | proving (median) |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...rows.map(
    (r) =>
      `| ${r.mip0018 ? '**' : ''}\`${r.example}\` · \`${r.circuit}\`${r.mip0018 ? '**' : ''} | ${r.note} | ${r.k} | ${r.rows.toLocaleString('en-US')} | ${size(r.proverKeyBytes)} | ${size(r.verifierKeyBytes)} | ${sec(r.proveMedianMs)} |`,
  ),
  '',
  '<!-- oz-costs:end -->',
].join('\n');
const doc = readFileSync(README, 'utf8');
const begin = doc.indexOf('<!-- oz-costs:begin');
const end = doc.indexOf('<!-- oz-costs:end -->');
if (begin < 0 || end < 0) throw new Error('examples/openzeppelin/README.md has no oz-costs:begin / oz-costs:end markers');
writeFileSync(README, `${doc.slice(0, begin)}${generated}${doc.slice(end + '<!-- oz-costs:end -->'.length)}`);
process.stderr.write(`wrote ${JSON_PATH} and the README costs table (${rows.length} circuits)\n`);
