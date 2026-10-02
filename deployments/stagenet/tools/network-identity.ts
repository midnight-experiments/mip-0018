// SPDX-License-Identifier: Apache-2.0
//
// Records the identity of the Stagenet network the cases ran on (spec FR-052): genesis hash, chain name, node build,
// runtime version, finalized head, the indexer's latest block, and (optional) the proof servers' versions. Wallet-free,
// read-only, a handful of requests at the public-endpoint politeness interval.
//
//   node deployments/stagenet/tools/network-identity.ts                               print one observation (JSON)
//   node deployments/stagenet/tools/network-identity.ts --append <network.json> --label <text>
//        [--prover <url>] [--wallet-prover <url>]                                     append it to a network file
//
// Exit 1 when the node's genesis hash is not the pinned Stagenet genesis (nothing is appended then).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { HttpClient, Indexer, NodeRpc, normGenesis, STAGENET, stagenetProfile } from '@mip0018/midnight';

const { values: v } = parseArgs({
  options: {
    append: { type: 'string' },
    label: { type: 'string' },
    prover: { type: 'string' },
    'wallet-prover': { type: 'string' },
  },
});

const profile = stagenetProfile();
const http = new HttpClient({ minIntervalMs: profile.minIntervalMs });
const rpc = new NodeRpc(profile.rpc, http);
const indexer = new Indexer(profile.indexer, profile.indexerWs, http);

const genesis = normGenesis((await rpc.blockHash(0)) ?? '');
const chain = await rpc.call<string>('system_chain');
const name = await rpc.call<string>('system_name');
const version = await rpc.call<string>('system_version');
const runtime = await rpc.call<Record<string, unknown>>('state_getRuntimeVersion');
const finalized = await rpc.finalizedHead();
const best = await rpc.bestHeight();
const latest = await indexer.query<{ block: { height: number; hash: string; timestamp: number; protocolVersion: number } }>(
  'query { block { height hash timestamp protocolVersion } }',
);

async function proverVersion(url: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!url) return undefined;
  const get = async (path: string) => {
    const r = await fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000) });
    const t = (await r.text()).trim();
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  };
  return { url, health: await get('/health'), version: await get('/version'), proofVersions: await get('/proof-versions') };
}

const observation = {
  label: v.label ?? 'observation',
  observedAt: new Date().toISOString(),
  genesisHash: genesis,
  genesisMatchesPin: genesis === STAGENET.genesisHash,
  node: {
    chain,
    name,
    version,
    specName: runtime.specName,
    specVersion: runtime.specVersion,
    transactionVersion: runtime.transactionVersion,
    stateVersion: runtime.stateVersion,
    finalizedHead: finalized,
    bestHeight: best,
  },
  indexer: { latestBlock: latest.block },
  ...(v.prover || v['wallet-prover']
    ? { proofServers: { contract: await proverVersion(v.prover), dust: await proverVersion(v['wallet-prover']) } }
    : {}),
  requests: http.requests,
};

if (!observation.genesisMatchesPin) {
  process.stderr.write(`wrong chain: genesis ${genesis}, expected ${STAGENET.genesisHash}\n`);
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
  process.exit(1);
}

if (v.append) {
  const doc = existsSync(v.append)
    ? (JSON.parse(readFileSync(v.append, 'utf8')) as { observations: unknown[] })
    : {
        $comment:
          'Stagenet identity during the S5/S6b runs (deployments/stagenet/tools/network-identity.ts). Public data only; re-run the tool to compare.',
        network: {
          id: 'stagenet',
          networkId: STAGENET.networkId,
          genesisHash: STAGENET.genesisHash,
          indexer: profile.indexer,
          indexerWs: profile.indexerWs,
          rpc: profile.rpc,
        },
        observations: [] as unknown[],
      };
  doc.observations.push(observation);
  writeFileSync(v.append, `${JSON.stringify(doc, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
