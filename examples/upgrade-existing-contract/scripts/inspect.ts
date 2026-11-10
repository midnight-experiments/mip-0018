// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free view of a deployed contract, for before/after an upgrade (docs/upgrade-guide.md, step 1):
//
//   node scripts/inspect.ts --network undeployed|preview|preprod|mainnet (--contract <address> | --record <run record>)
//        [--ledger <managed dir>]... [--block <height>] [--blockfrost-token-file <0600 file>]
//
// Prints JSON: the entry points with the SHA-256 of their verifier keys, the maintenance authority (committee size,
// threshold, counter — a frozen authority cannot add a circuit), the SHA-256 of the ledger data (what every holder's
// balance and the token's domain live in) and, per --ledger build, the state decoded through that build's ledger()
// accessor. Reads the node's identity and the indexer (undeployed: MIP0018_INDEXER_URL / MIP0018_NODE_URL; preprod / mainnet: the Blockfrost
// project token from MIP0018_BLOCKFROST_PREPROD / MIP0018_BLOCKFROST_MAINNET or --blockfrost-token-file). The state is the one the
// contract's latest action left; with --block, the one its action in that block left (exit 3 when it has none there).
//
// Before the first indexer read the node's identity is checked: its genesis (pinned for the public networks; a public
// network's genesis is refused for undeployed) and, with --record, the genesis and chain instance (block 1) the record
// and its case folder's network file name. Output is filtered like the mip0018 CLI's, and an error is printed as one
// scrubbed line (exit 1), so no token reaches the terminal.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ContractState } from '@midnightntwrk/ledger-v9';
import {
  checkIdentity,
  decodeDeployedLedger,
  httpFor,
  indexerFor,
  profileForFiles,
  resolveProfile,
  runTool,
  toJson,
  type RecordedNetwork,
  type RecordedSource,
} from '@mip0018/midnight';

await runTool('inspect', async () => {
  const { values } = parseArgs({
    options: {
      network: { type: 'string', default: 'undeployed' },
      contract: { type: 'string' },
      record: { type: 'string' },
      ledger: { type: 'string', multiple: true, default: [] },
      block: { type: 'string' },
      'blockfrost-token-file': { type: 'string' },
    },
  });
  // --record: the contract address of a mip0018 run record (public JSON), e.g. a case's record.json, and the network
  // identity it recorded
  let contract = values.contract;
  const recorded: RecordedSource[] = [];
  if (values.record !== undefined) {
    const r = JSON.parse(readFileSync(values.record, 'utf8')) as {
      kind?: string;
      network?: RecordedNetwork;
      contract?: { address?: string };
    };
    if (r.kind !== 'mip0018-run-record' || r.network === undefined) throw new Error(`${values.record} is not a mip0018 run record`);
    recorded.push({ source: values.record, network: r.network });
    contract ??= r.contract?.address;
  }
  if (!contract) throw new Error('--contract <address> (or --record <run record with a deployed contract>) is required');
  const profile = profileForFiles(
    resolveProfile(values.network, values['blockfrost-token-file'] ? { tokenFile: values['blockfrost-token-file'] } : {}),
    recorded.map((r) => r.source),
    recorded,
  );
  const atBlock = values.block === undefined ? undefined : Number(values.block);
  if (atBlock !== undefined && !(Number.isInteger(atBlock) && atBlock >= 0)) throw new Error('--block <height> must be a block height');
  const http = httpFor(profile);
  await checkIdentity(profile, http);
  const row = await indexerFor(profile, http).contractState(contract, atBlock);
  if (!row) {
    process.stdout.write(`${toJson({ contract, exists: false, ...(atBlock !== undefined ? { atBlock } : {}) })}\n`);
    return 3;
  }
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const state = ContractState.deserialize(Buffer.from(row.state, 'hex'));
  const operations: Record<string, string | null> = {};
  for (const op of state.operations()) {
    const name = typeof op === 'string' ? op : Buffer.from(op).toString('utf8');
    try {
      const vk = state.operation(op)?.verifierKey;
      operations[name] = vk && vk.length > 0 ? sha(vk) : null;
    } catch {
      operations[name] = null;
    }
  }
  const auth = state.maintenanceAuthority;
  // The ledger data alone (a ContractState holding only it), so operations and authority do not affect the hash.
  const dataOnly = new ContractState();
  dataOnly.data = state.data;
  const decoded: Record<string, unknown> = {};
  for (const dir of values.ledger) decoded[dir] = await decodeDeployedLedger(dir, row.state);
  process.stdout.write(
    `${toJson({
      contract,
      exists: true,
      block: row.block,
      lastAction: row.action,
      lastTx: row.txHash,
      operations,
      maintenanceAuthority: { committeeSize: auth.committee.length, threshold: auth.threshold, counter: auth.counter.toString() },
      dataSha256: sha(dataOnly.serialize()),
      decoded,
    })}\n`,
  );
  return 0;
});
