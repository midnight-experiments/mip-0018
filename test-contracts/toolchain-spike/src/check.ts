// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free re-check of a recorded Stagenet spike run against the public
// endpoints (no secret, no proof server):
//
//   docker/run.sh spike:check            # checks records/stagenet.json
//
// Checks: chain identity (genesis), each recorded transaction is in the indexer
// with status SUCCESS at the recorded block and the node RPC agrees on the block
// hash and finality, the contract has exactly one Misc event whose name and
// payload equal MIP-0018 A1, and publishMetadata has no verifier key.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractView, miscEvents, rpc, transactionByHash } from './lib/chain.js';
import { A1_PAYLOAD_HEX, EVENT_NAME_HEX } from './lib/expected.js';
import { STAGENET_GENESIS, type NetworkConfig } from './lib/network.js';

const network: NetworkConfig = {
  name: 'stagenet',
  networkId: 'stagenet',
  indexer: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
  indexerWs: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
  node: 'https://rpc.stagenet.shielded.tools',
  nodeWs: 'wss://rpc.stagenet.shielded.tools',
  proofServer: 'unused',
  walletProofServer: 'unused',
  genesisHash: STAGENET_GENESIS,
};

const recordPath = process.argv[2] ?? join(import.meta.dirname, '..', 'records', 'stagenet.json');
const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
  contract: string;
  steps: Record<string, { txHash: string; blockHeight: number; blockHash: string }>;
};
const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ check: name, ok, detail });

const genesis = await rpc<string>(network, 'chain_getBlockHash', [0]);
check('genesis hash is Stagenet', genesis === STAGENET_GENESIS, genesis);
const finalizedHead = await rpc<string>(network, 'chain_getFinalizedHead');
const finalized = Number((await rpc<{ number: string }>(network, 'chain_getHeader', [finalizedHead])).number);

for (const step of ['deploy', 'call', 'removeVerifierKey']) {
  const s = record.steps[step];
  if (!s) {
    check(`${step} recorded`, false);
    continue;
  }
  const tx = await transactionByHash(network, s.txHash);
  check(`${step}: indexer status SUCCESS at block ${s.blockHeight}`, tx?.status === 'SUCCESS' && tx.block.height === s.blockHeight, tx);
  const nodeHash = await rpc<string>(network, 'chain_getBlockHash', [s.blockHeight]);
  check(`${step}: node block hash equals the indexer's`, nodeHash.replace(/^0x/u, '') === tx?.block.hash, nodeHash);
  check(`${step}: finalized (finalized head ${finalized})`, finalized >= s.blockHeight);
}

const events = await miscEvents(network, record.contract);
check('exactly one Misc event bound to the contract', events.length === 1 && events[0]!.contractAddress === record.contract, events.length);
check('event name = pad(32, "mip-0018:token-metadata[v1]")', events[0]?.name === EVENT_NAME_HEX);
check('event payload = MIP-0018 A1 byte-for-byte', events[0]?.payload === A1_PAYLOAD_HEX);
check('event is in the recorded call transaction', events[0]?.transaction.hash === record.steps.call?.txHash);
const view = await contractView(network, record.contract);
check('publishMetadata has no verifier key any more', view.exists && !view.operations.includes('publishMetadata'), view);

for (const r of results) process.stdout.write(`${r.ok ? 'OK  ' : 'FAIL'} ${r.check}\n`);
if (results.some((r) => !r.ok)) {
  process.stdout.write(
    `${JSON.stringify(
      results.filter((r) => !r.ok),
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
