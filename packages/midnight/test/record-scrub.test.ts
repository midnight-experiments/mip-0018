// SPDX-License-Identifier: Apache-2.0
//
// A run record on disk never holds the project token, a `project_id` value or URL credentials, in whichever field a
// diagnostic lands (the node-rejection diagnostic of a step, or a field nobody scrubs by name), while published values
// such as a metadata URL with its own query string are written exactly (record-published-values.test.ts). The node-rejection diagnostic is built from a
// wallet-SDK-shaped error chain whose node-client error quotes its token-bearing, authenticated endpoint.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveProfile } from '../src/network.ts';
import { describeError, saveRecord, type RunRecord } from '../src/signer/index.ts';

const TOKEN = 'FakeTokenRecord0123456789';
// Registers the token, as every preprod / mainnet run does when it reads it.
resolveProfile('preprod', {}, { MIP0018_BLOCKFROST_PREPROD: TOKEN });
const ENDPOINT = `wss://user:Passw0rdSecret@rpc.midnight-preprod.blockfrost.io/?project_id=${TOKEN}`;

const dir = mkdtempSync(join(tmpdir(), 'mip0018-record-scrub-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The shape the wallet SDK reports a node rejection in: FiberFailure → SubmissionError → the node client's error. */
function nodeRejection(): Error {
  const client = Object.assign(new Error(`1010: Invalid Transaction: Custom error: 166 (request to ${ENDPOINT})`), {
    data: { endpoint: ENDPOINT, project_id: TOKEN },
  });
  const submission = Object.assign(new Error('Transaction submission error', { cause: client }), { _tag: 'SubmissionError' });
  return Object.assign(new Error('(FiberFailure) SubmissionError: Transaction submission error'), {
    [Symbol.for('effect/Runtime/FiberFailure/Cause')]: { failure: submission },
  });
}

function record(diagnostic: string): RunRecord {
  return {
    kind: 'mip0018-run-record',
    schema: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    network: {
      id: 'preprod',
      networkId: 'preprod',
      genesisHash: `0x${'df'.repeat(32)}`,
      indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${TOKEN}`,
      rpc: ENDPOINT,
    },
    contract: { name: 'X', managedDir: 'm', verifierKeySha256: {}, address: 'ab'.repeat(32) },
    steps: [
      {
        id: 'insert',
        kind: 'verifier-key-insert',
        args: { image: 'https://example.org/acme.png?size=2' },
        state: 'failed',
        error: diagnostic,
        observed: {
          rejectedByNode: diagnostic,
          nested: { later: [{ copy: diagnostic, note: `see ${ENDPOINT}`, [`project_id`]: TOKEN }] },
        },
        attempts: [{ at: '2026-01-01T00:00:00.000Z', event: `REJECTED: ${diagnostic}` }],
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('run records never carry a token or URL credentials', () => {
  it('the node-rejection diagnostic keeps the node reason and drops the token and the credentials', () => {
    const d = describeError(nodeRejection());
    expect(d).toMatch(/1010: Invalid Transaction: Custom error: 166/u);
    expect(d).not.toContain(TOKEN);
    expect(d).not.toContain('Passw0rdSecret');
  });

  it('saveRecord writes no token, no project_id value and no credentials from any field; published values stay exact', () => {
    const p = join(dir, 'record.json');
    const raw = `ProviderFailedError: submitTx rejected the transaction <- 1010: Invalid Transaction (request to ${ENDPOINT}) <- ${TOKEN}`;
    const r = record(raw);
    saveRecord(p, r);
    const text = readFileSync(p, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('Passw0rdSecret');
    const back = JSON.parse(text) as RunRecord;
    expect(back.steps[0]!.args).toMatchObject({ image: 'https://example.org/acme.png?size=2' });
    expect(JSON.stringify(back.steps[0]!.observed)).toMatch(/1010: Invalid Transaction/u);
  });
});
