// SPDX-License-Identifier: Apache-2.0
//
// Records the identity of the public network the cases run on: genesis hash, chain instance (block 1 hash), chain
// name, node build, runtime version, finalized head, the indexer's latest block, and (optional) the proof server's
// version. Wallet-free, read-only, a handful of requests at the public-endpoint politeness interval.
//
//   node deployments/tools/network-identity.ts --network <preview|preprod|mainnet>          print one observation (JSON)
//   node deployments/tools/network-identity.ts --network <id> --append <network.json> --label <text> [--prover <url>]
//                                                                                            append it to a network file
//
// preprod / mainnet read their Blockfrost project token like the CLI (MIP0018_BLOCKFROST_PREPROD / _MAINNET or
// --blockfrost-token-file); every URL written is the profile's, without a query string.
//
// The network file (deployments/<network>/network.json) pins the chain instance of its first observation; `mip0018
// recheck` then requires that block 1 for every case of the folder. Exit 1 (nothing appended) when the node's genesis
// is not the pinned one, or its block 1 differs from the chain instance the file already holds.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  httpFor,
  indexerFor,
  normGenesis,
  PUBLIC_NETWORKS,
  redactUrl,
  resolveProfile,
  rpcFor,
  scrubSecrets,
  type PublicNetworkId,
} from '@mip0018/midnight';

const { values: v } = parseArgs({
  options: {
    network: { type: 'string' },
    append: { type: 'string' },
    label: { type: 'string' },
    prover: { type: 'string' },
    'blockfrost-token-file': { type: 'string' },
  },
});

if (v.network === undefined || !Object.hasOwn(PUBLIC_NETWORKS, v.network)) {
  process.stderr.write(`--network <${Object.keys(PUBLIC_NETWORKS).join('|')}> is required\n`);
  process.exit(2);
}
const id = v.network as PublicNetworkId;
const pinned = PUBLIC_NETWORKS[id];

interface NetworkFile {
  $comment: string;
  network: {
    id: string;
    networkId: string;
    chain: string;
    genesisHash: string;
    chainInstance: string;
    indexer: string;
    indexerWs: string;
    rpc: string;
  };
  observations: unknown[];
}

try {
  const profile = resolveProfile(id, v['blockfrost-token-file'] ? { tokenFile: v['blockfrost-token-file'] } : {});
  const http = httpFor(profile);
  const rpc = rpcFor(profile, http);
  const indexer = indexerFor(profile, http);

  const genesis = normGenesis((await rpc.blockHash(0)) ?? '00'.repeat(32));
  const one = await rpc.blockHash(1);
  const chainInstance = one === null ? null : normGenesis(one);
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
    return {
      url: redactUrl(url),
      health: await get('/health'),
      version: await get('/version'),
      proofVersions: await get('/proof-versions'),
    };
  }

  const doc: NetworkFile | undefined =
    v.append !== undefined && existsSync(v.append) ? (JSON.parse(readFileSync(v.append, 'utf8')) as NetworkFile) : undefined;
  const expectedInstance = doc?.network.chainInstance;

  const observation = {
    label: v.label ?? 'observation',
    observedAt: new Date().toISOString(),
    genesisHash: genesis,
    genesisMatchesPin: genesis === pinned.genesisHash,
    chainInstance,
    ...(expectedInstance !== undefined ? { chainInstanceMatches: chainInstance === expectedInstance } : {}),
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
    ...(v.prover ? { proofServer: await proverVersion(v.prover) } : {}),
    requests: http.requests,
  };

  const refuse = (why: string) => {
    process.stderr.write(`${why}\n`);
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    process.exit(1);
  };
  if (!observation.genesisMatchesPin) refuse(`wrong chain: genesis ${genesis}, expected ${pinned.genesisHash} (${id})`);
  if (doc && doc.network.id !== id) refuse(`${v.append} is for ${doc.network.id}, not ${id}`);
  if (expectedInstance !== undefined && chainInstance !== expectedInstance)
    refuse(
      `another instance of ${id}: block 1 is ${chainInstance ?? 'missing'}, ${v.append} holds ${expectedInstance} (re-created network)`,
    );

  if (v.append !== undefined) {
    if (chainInstance === null) refuse(`${id} has no block 1 yet`);
    const out: NetworkFile = doc ?? {
      $comment: `${pinned.chain} identity during the case runs (deployments/tools/network-identity.ts --network ${id}). Public data only; re-run the tool to compare. mip0018 recheck requires chainInstance (block 1) for every case in cases/.`,
      network: {
        id,
        networkId: profile.networkId,
        chain: pinned.chain,
        genesisHash: pinned.genesisHash,
        chainInstance: chainInstance!,
        indexer: redactUrl(profile.indexer),
        indexerWs: redactUrl(profile.indexerWs),
        rpc: redactUrl(profile.rpc),
      },
      observations: [],
    };
    out.observations.push(observation);
    writeFileSync(v.append, `${JSON.stringify(out, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
} catch (e) {
  process.stderr.write(scrubSecrets(`network-identity: ${(e as Error).name}: ${(e as Error).message}\n`));
  process.exit(1);
}
