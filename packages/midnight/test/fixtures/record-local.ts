// SPDX-License-Identifier: Apache-2.0
//
// Records the chain exchanges the unit tests replay, from a local stack (docker/local-stack) after the end-to-end
// tests have run on it. Read-only: every request is a query of the indexer or the node RPC.
//
//   docker/run.sh exec 'node packages/midnight/test/fixtures/record-local.ts --emitter <run record> --case-dir <dir>'
//     (MIP0018_DOCKER_NETWORK = the stack's network, MIP0018_DOCKER_ENV mounting the end-to-end directory)
//
//   --emitter <file>   local-e2e.sh's SpikeEmitter run record (deploy, publishMetadata = MIP-0018 A1, VerifierKeyRemove)
//   --case-dir <dir>   examples-e2e.sh's case output directory (C04: one asset minted as a shielded coin and an
//                      unshielded UTXO, then three events in one call; C08: two events in one call, the second malformed)
//   --case-defs <dir>  the case folders those runs used (expectations of C04 and C08)
//
// Writes packages/midnight/test/fixtures/local/: meta.json (what was recorded, against which chain), the tapes and the
// reports they produced at recording time, mint-txs.json (the two mint transactions with the color the indexer and an
// independent SHA-256 derivation agree on) and the check-event reports of the two multi-event transactions.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { HttpClient } from '../../src/http.ts';
import { indexerFor, rpcFor, undeployedProfile } from '../../src/network.ts';
import { checkEvent } from '../../src/check-event.ts';
import { listMetadata } from '../../src/list.ts';
import { scan } from '../../src/scanner.ts';
import { tokenTypeHex, tokenTypeSha256 } from '../../src/color.ts';
import { toJson } from '../../src/hex.ts';
import { recordingFetch, saveTape, type Exchange } from '../support/cassette.ts';

const { values: v } = parseArgs({
  options: { emitter: { type: 'string' }, 'case-dir': { type: 'string' }, 'case-defs': { type: 'string' } },
});
if (!v.emitter || !v['case-dir'] || !v['case-defs']) throw new Error('--emitter, --case-dir and --case-defs are required');
const caseDir = v['case-dir'];
const caseDefs = v['case-defs'];

const out = join(import.meta.dirname, 'local');
mkdirSync(out, { recursive: true });
/** The URLs every container on the stack's network uses (the tapes match on them). */
const profile = undeployedProfile({ indexer: 'http://indexer:8088/api/v4/graphql', rpc: 'http://node:9944' });

type Step = {
  id: string;
  kind: string;
  circuit?: string;
  state: string;
  args?: unknown;
  tx?: { hash: string };
  inclusion?: { height: number; hash: string; status: string };
};
type RunRecord = { contract: { address: string }; steps: Step[] };
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const done = (
  r: RunRecord,
  f: (s: Step) => boolean,
  what: string,
): Step & { tx: { hash: string }; inclusion: NonNullable<Step['inclusion']> } => {
  const s = r.steps.find((x) => f(x) && x.state === 'completed' && x.tx && x.inclusion);
  if (!s) throw new Error(`no completed ${what} step`);
  return s as never;
};

async function rec(name: string, run: (http: HttpClient) => Promise<unknown>): Promise<unknown> {
  const tape: Exchange[] = [];
  const http = new HttpClient({ fetch: recordingFetch(tape) });
  const result = await run(http);
  saveTape(join(out, `${name}.tape.json`), tape);
  writeFileSync(join(out, `${name}.result.json`), `${toJson(result, 1)}\n`);
  process.stdout.write(`${name}: ${tape.length} exchanges\n`);
  return result;
}

const rpc = rpcFor(profile);
const indexer = indexerFor(profile);
const genesisHash = (await rpc.blockHash(0))!;
const chainInstance = (await rpc.blockHash(1))!;

// ------------------------------------------------------------------------------- SpikeEmitter: deploy, A1, removal
const em = readJson<RunRecord>(v.emitter);
const deploy = done(em, (s) => s.kind === 'deploy', 'deploy');
const publish = done(em, (s) => s.kind === 'call' && s.circuit === 'publishMetadata', 'publishMetadata');
const remove = done(em, (s) => s.kind === 'verifier-key-remove', 'VerifierKeyRemove');
const emitter = em.contract.address;
const scanFrom = deploy.inclusion.height - 2;
const scanTo = remove.inclusion.height + 2;
await rec('check-event-emitter-publish', (http) => checkEvent({ profile, contract: emitter, tx: publish.tx.hash, http }));
await rec('check-event-emitter-deploy', (http) => checkEvent({ profile, contract: emitter, tx: deploy.tx.hash, http }));
await rec('list-emitter', (http) => listMetadata({ profile, contract: emitter, toBlock: scanTo, http }));
const dir = mkdtempSync(join(tmpdir(), 'mip0018-scan-'));
try {
  await rec(
    'scan-emitter',
    async (http) => (await scan({ profile, stateDir: dir, fromHeight: scanFrom, toHeight: scanTo, poll: true, http })).state,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------------- C04: the two mints of one domainSep
const c04 = readJson<RunRecord>(join(caseDir, 'C04', 'record.json'));
const domainSep = readJson<{ recheck: { colors: { domainSep: string }[] } }>(join(caseDefs, 'C04', 'case.json'))
  .recheck.colors[0]!.domainSep.replace(/^0x/u, '')
  .toLowerCase();
const color = tokenTypeSha256(domainSep, c04.contract.address);
if (color !== tokenTypeHex(domainSep, c04.contract.address)) throw new Error('the two color derivations disagree');
const mints = [];
for (const s of [
  done(c04, (x) => x.id === 'mint-shielded', 'mint-shielded'),
  done(c04, (x) => x.id === 'mint-unshielded', 'mint-unshielded'),
]) {
  const t = await indexer.query<{
    transactions: {
      hash: string;
      raw: string;
      block: { height: number; hash: string };
      transactionResult: unknown;
      unshieldedCreatedOutputs?: { owner: string; tokenType: string; value: string; intentHash: string; outputIndex: number }[];
    }[];
  }>(
    `query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) { hash raw block { height hash }
       ... on RegularTransaction { transactionResult { status segments { id success } }
         unshieldedCreatedOutputs { owner tokenType value intentHash outputIndex } } } }`,
    { hash: s.tx.hash },
  );
  const x = t.transactions[0]!;
  mints.push({
    entryPoint: s.circuit,
    hash: x.hash,
    height: x.block.height,
    blockHash: x.block.hash,
    transactionResult: x.transactionResult,
    amount: String((s.args as unknown[])[1]),
    raw: x.raw,
    unshieldedCreatedOutputs: (x.unshieldedCreatedOutputs ?? []).filter((o) => o.tokenType === color),
  });
}
const unshieldedOut = mints.find((m) => m.entryPoint === 'mintUnshielded')!.unshieldedCreatedOutputs;
if (unshieldedOut.length !== 1) throw new Error('the indexer does not list the unshielded mint output of the derived color');
writeFileSync(
  join(out, 'mint-txs.json'),
  `${JSON.stringify(
    {
      $comment:
        'The two mint transactions of one asset (examples/openzeppelin/multi-kind: mintShielded and mintUnshielded of one domainSep), recorded from the local stack by record-local.ts. The color is the SHA-256 derivation of tokenType(domainSep, contract) (color.ts tokenTypeSha256), equal to ledger-v9 rawTokenType and to the unshielded output tokenType the indexer serves.',
      contractAddress: c04.contract.address,
      transactions: mints,
      expected: { domainSep, color },
    },
    null,
    1,
  )}\n`,
);

// ------------------------------------------------------------------ C04 and C08: several events in one transaction
const reportOf = async (id: string, step: string, expectFile: string, file: string) => {
  const r = readJson<RunRecord>(join(caseDir, id, 'record.json'));
  const s = done(r, (x) => x.id === step, `${id} ${step}`);
  const expect = readJson<never>(join(caseDefs, id, expectFile));
  const report = await checkEvent({ profile, contract: r.contract.address, tx: s.tx.hash, expect, http: new HttpClient() });
  if (report.exitCode !== 0) throw new Error(`${id} ${step}: check-event ${report.outcome}`);
  writeFileSync(join(out, file), `${toJson(report, 1)}\n`);
  writeFileSync(join(out, file.replace(/\.json$/u, '.expect.json')), `${JSON.stringify(expect, null, 1)}\n`);
  process.stdout.write(`${file}: ${report.events.length} events\n`);
};
await reportOf('C04', 'publish', 'expect/publish.json', 'check-event-multi-kind-publish.json');
await reportOf('C08', 'emit-two', 'expect/emit-two.json', 'check-event-emit-two.json');

const nodeVersion = await rpc.systemVersion();
writeFileSync(
  join(out, 'meta.json'),
  `${JSON.stringify(
    {
      $comment:
        'What the tapes in this folder were recorded from: a local stack (docker/local-stack, official images) after packages/cli/test/e2e/local-e2e.sh and examples-e2e.sh ran on it. URLs are the in-network ones every container uses.',
      recordedAt: new Date().toISOString(),
      node: nodeVersion,
      indexer: profile.indexer,
      rpc: profile.rpc,
      genesisHash,
      chainInstance,
      emitter: {
        address: emitter,
        deploy: { tx: deploy.tx.hash, height: deploy.inclusion.height },
        publish: { tx: publish.tx.hash, height: publish.inclusion.height },
        remove: { tx: remove.tx.hash, height: remove.inclusion.height },
        scan: { from: scanFrom, to: scanTo },
      },
    },
    null,
    1,
  )}\n`,
);
process.stdout.write(`meta.json: genesis ${genesisHash}, node ${nodeVersion}\n`);
