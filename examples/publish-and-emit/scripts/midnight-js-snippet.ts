// SPDX-License-Identifier: Apache-2.0
//
// Appendix of the publish-and-emit walkthrough (issuer guide): the plain midnight-js calls under
// `mip0018 deploy-and-publish`, WITHOUT the CLI's run record and before/after checks — deploy the OpenZeppelin
// fungible-token example with `deployContract`, then call `publishMetadata()` right after the deployment with
// `callTx`. Local stack only (the dev chain's public genesis wallet; no secret):
//
//   . docker/local-stack/ports.env
//   MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK MIP0018_DOCKER_ENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK \
//     -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK \
//     -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK" \
//     docker/run.sh exec 'node examples/publish-and-emit/scripts/midnight-js-snippet.ts'
//
// The midnight-js providers (wallet, proofs, indexer, private state) come from @mip0018/midnight/signer for brevity;
// any `MidnightProviders` work. Everything between the two "midnight-js" markers is what an issuer writes.

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { resolveProfile } from '@mip0018/midnight';
import {
  GENESIS_DEV_SEED_HEX,
  buildProviders,
  closeWallet,
  filePrivateStateProvider,
  loadCompiledContract,
  openWallet,
  waitForSync,
} from '@mip0018/midnight/signer';

const name = 'MyFungibleToken';
const managedDir = 'examples/openzeppelin/fungible-token/managed/MyFungibleToken'; // compiled WITH keys
const env = (k: string) =>
  process.env[k] ??
  (() => {
    throw new Error(`${k} is not set`);
  })();

const profile = resolveProfile('undeployed');
const ep = { profile, proofServer: env('MIP0018_PROOF_SERVER_URL'), walletProofServer: env('MIP0018_WALLET_PROOF_SERVER_URL') };
const session = await openWallet(ep, Uint8Array.from(Buffer.from(GENESIS_DEV_SEED_HEX, 'hex')));
try {
  await waitForSync(session);
  const privateState = join(mkdtempSync(join(tmpdir(), 'mip0018-snippet-')), 'private-state.json');
  const providers = buildProviders(ep, session, { name, managedDir }, filePrivateStateProvider(privateState));

  // ---------------------------------------------------------------------------------------------- midnight-js
  type OwnerState = { secretKey: Uint8Array };
  const secret = ({ privateState }: { privateState: OwnerState }): [OwnerState, Uint8Array] => [privateState, privateState.secretKey];
  const compiledContract = await loadCompiledContract({ name, managedDir }, { wit_OwnableSK: secret, wit_FungibleTokenSK: secret });

  const secretKey = Uint8Array.from(randomBytes(32)); // the owner's secret: stays in the private state
  const ownerId = persistentHash(new CompactTypeVector(1, new CompactTypeBytes(32)), [secretKey]); // OZ Utils.computeAccountId

  // 1. deploy — the same literals go to the constructor (getters) and are compiled into publishMetadata()
  const deployed = await deployContract(
    providers as never,
    {
      compiledContract,
      privateStateId: name,
      initialPrivateState: { secretKey },
      args: ['Acme Gold', 'AGLD', 6n, { is_left: true, left: ownerId, right: { bytes: new Uint8Array(32) } }],
    } as never,
  );

  // 2. publish the metadata right after the deployment (Ownable: only the deployer's secret passes)
  const published = await (
    deployed as unknown as {
      callTx: { publishMetadata: () => Promise<{ public: { txHash: string; blockHeight: number; status: string } }> };
    }
  ).callTx.publishMetadata();
  // ---------------------------------------------------------------------------------------------- midnight-js

  const d = (deployed as unknown as { deployTxData: { public: { contractAddress: string; txHash: string; blockHeight: number } } })
    .deployTxData.public;
  process.stdout.write(
    `${JSON.stringify({ contract: d.contractAddress, deploy: { tx: d.txHash, block: d.blockHeight }, publish: { tx: published.public.txHash, block: published.public.blockHeight, status: published.public.status } })}\n`,
  );
} finally {
  await closeWallet(session);
}
