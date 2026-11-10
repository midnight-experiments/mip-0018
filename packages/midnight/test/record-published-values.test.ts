// SPDX-License-Identifier: Apache-2.0
//
// A run record is written with its published values exactly as the signer sent them (circuit and constructor
// arguments, the decoded ledger state of an upgrade's pre-checks): an `@` in a query string, credentials in a URL or
// `project_id` text in a published value are data, and only a registered token is removed from them. Saving changes
// none of the caller's objects, and saving a saved record writes the same bytes, including every committed preview
// record.

import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveProfile } from '../src/network.ts';
import { loadRecord, saveRecord, type RunRecord } from '../src/signer/index.ts';

const TOKEN = 'FakeTokenPublished0123456789';
// Registers the token, as every preprod / mainnet run does when it reads it.
resolveProfile('preprod', {}, { MIP0018_BLOCKFROST_PREPROD: TOKEN });

const dir = mkdtempSync(join(tmpdir(), 'mip0018-record-published-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Values a token's metadata or a circuit argument may hold, none of them a secret. */
const PUBLISHED = [
  'https://images.example?owner=alice@example.org',
  'https://user@issuer.example/logo.png',
  'https://user:pass@issuer.example/logo.png?project_id=public#frag',
  'name with project_id: in prose',
  { $utf8: 'project_id=abcdefgh1234', pad: 32 },
  { project_id: 'a published field' },
];

function record(extra: Partial<RunRecord['steps'][number]> = {}): RunRecord {
  return {
    kind: 'mip0018-run-record',
    schema: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    network: {
      id: 'preprod',
      networkId: 'preprod',
      genesisHash: `0x${'df'.repeat(32)}`,
      indexer: 'https://i.example/api',
      rpc: 'https://r.example',
    },
    contract: {
      name: 'X',
      managedDir: 'm',
      verifierKeySha256: {},
      address: 'ab'.repeat(32),
      constructorArgs: structuredClone(PUBLISHED),
      upgrades: [
        {
          circuit: 'publishMetadata',
          slot: 'v4',
          contract: 'U',
          managedDir: 'u',
          verifierKeySha256: '00',
          checks: { decoded: { name: 'Acme', image: PUBLISHED[1], note: PUBLISHED[3] } },
        },
      ],
    },
    steps: [
      {
        id: 'publish',
        kind: 'call',
        circuit: 'publishMetadata',
        args: structuredClone(PUBLISHED),
        state: 'completed',
        attempts: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        ...extra,
      },
    ],
  };
}

const save = (name: string, r: RunRecord): string => {
  const p = join(dir, name);
  saveRecord(p, r);
  return readFileSync(p, 'utf8');
};
const withoutUpdatedAt = (text: string) => text.replace(/"updatedAt": "[^"]*"/u, '"updatedAt": "-"');

describe('run records keep published values exactly', () => {
  it('circuit and constructor arguments and decoded ledger state are written byte for byte', () => {
    const back = JSON.parse(save('published.json', record())) as RunRecord;
    expect(back.steps[0]!.args).toEqual(PUBLISHED);
    expect(back.contract.constructorArgs).toEqual(PUBLISHED);
    expect(back.contract.upgrades![0]!.checks).toEqual({ decoded: { name: 'Acme', image: PUBLISHED[1], note: PUBLISHED[3] } });
  });

  it('a registered token is removed from every field, published values included', () => {
    const r = record({ error: `failed at https://r.example/?project_id=${TOKEN}`, observed: { echo: TOKEN } });
    (r.steps[0]!.args as unknown[]).push(`https://images.example/${TOKEN}.png`);
    r.contract.constructorArgs = [`x${TOKEN}`];
    const text = save('token.json', r);
    expect(text).not.toContain(TOKEN);
    const back = JSON.parse(text) as RunRecord;
    expect((back.steps[0]!.args as unknown[]).at(-1)).toBe('https://images.example/[redacted].png');
  });

  it("saving changes none of the caller's objects", () => {
    const r = record({
      error: 'refused at https://user:pw@r.example/?project_id=abcdefgh1234',
      observed: { note: 'https://u@h.example/x' },
    });
    const args = r.steps[0]!.args as unknown[];
    const before = structuredClone(r);
    save('caller.json', r);
    expect(r.steps[0]!.args).toBe(args);
    expect(args).toEqual(PUBLISHED);
    expect({ ...r, updatedAt: before.updatedAt }).toEqual(before);
  });

  it('a saved record saved again is written with the same bytes (apart from updatedAt)', () => {
    const r = record({
      error: 'at wss://a:b@c@node.example/ws?project_id=abcdefgh1234 and project_id: ijklmnop5678',
      observed: { note: 'https://a:b@c@host.example/x?q=1', text: "'project_id' => 'qrstuvwx9012'" },
    });
    const first = save('again.json', r);
    const second = save('again.json', loadRecord(join(dir, 'again.json'))!);
    expect(withoutUpdatedAt(second)).toBe(withoutUpdatedAt(first));
  });

  it('every committed preview record, saved again, keeps its bytes (apart from updatedAt)', () => {
    const cases = join(import.meta.dirname, '..', '..', '..', 'deployments', 'preview', 'cases');
    const records = readdirSync(cases)
      .map((c) => join(cases, c, 'record.json'))
      .filter((p) => {
        try {
          return readFileSync(p).length > 0;
        } catch {
          return false;
        }
      });
    expect(records.length).toBeGreaterThanOrEqual(12);
    for (const p of records) {
      const copy = join(dir, `committed-${records.indexOf(p)}.json`);
      copyFileSync(p, copy);
      saveRecord(copy, loadRecord(copy)!);
      expect(withoutUpdatedAt(readFileSync(copy, 'utf8')), p).toBe(withoutUpdatedAt(readFileSync(p, 'utf8')));
    }
  });
});
