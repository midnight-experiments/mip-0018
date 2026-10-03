// SPDX-License-Identifier: Apache-2.0
//
// Wallet-free view of a deployed contract, for before/after an upgrade (docs/upgrade-guide.md, step 1):
//
//   node scripts/inspect.ts --network stagenet|undeployed (--contract <address> | --record <run record>) [--ledger <managed dir>]...
//        [--block <height>]
//
// Prints JSON: the entry points with the SHA-256 of their verifier keys, the maintenance authority (committee size,
// threshold, counter — a frozen authority cannot add a circuit), the SHA-256 of the ledger data (what every holder's
// balance and the token's domain live in) and, per --ledger build, the state decoded through that build's ledger()
// accessor. Reads the indexer only (undeployed: MIP0018_INDEXER_URL / MIP0018_NODE_URL). The state is the one the
// contract's latest action left; with --block, the one its action in that block left (exit 3 when it has none there).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ContractState } from '@midnightntwrk/ledger-v9';
import { Indexer, decodeDeployedLedger, resolveProfile, toJson } from '@mip0018/midnight';

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'undeployed' },
    contract: { type: 'string' },
    record: { type: 'string' },
    ledger: { type: 'string', multiple: true, default: [] },
    block: { type: 'string' },
  },
});
// --record: the contract address of a mip0018 run record (public JSON), e.g. a Stagenet case's record.json
if (!values.contract && values.record)
  values.contract = (JSON.parse(readFileSync(values.record, 'utf8')) as { contract: { address?: string } }).contract.address;
if (!values.contract) throw new Error('--contract <address> (or --record <run record with a deployed contract>) is required');
const profile = resolveProfile(values.network);
const atBlock = values.block === undefined ? undefined : Number(values.block);
if (atBlock !== undefined && !(Number.isInteger(atBlock) && atBlock >= 0)) throw new Error('--block <height> must be a block height');
const row = await new Indexer(profile.indexer, profile.indexerWs).contractState(values.contract, atBlock);
if (!row) {
  process.stdout.write(`${toJson({ contract: values.contract, exists: false, ...(atBlock !== undefined ? { atBlock } : {}) })}\n`);
  process.exit(3);
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
    contract: values.contract,
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
