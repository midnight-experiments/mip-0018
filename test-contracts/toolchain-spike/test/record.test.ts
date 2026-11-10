// SPDX-License-Identifier: Apache-2.0
//
// The local tools' records (the toolchain spike's, and create-and-destroy's, which uses the same recorder) hold no
// registered token and no `project_id` value, in whichever field a node's answer or an error lands.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerSecret } from '@mip0018/midnight';
import { recorder, type SpikeRecord } from '../src/lib/spike.ts';

const TOKEN = 'FakeTokenSpikeRecord0123456789';
registerSecret(TOKEN);
const dir = mkdtempSync(join(tmpdir(), 'mip0018-spike-record-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('local tool records', () => {
  it('a token in a node answer, an error and a step error is not written', () => {
    const p = join(dir, 'nested', 'spike.json');
    const record: SpikeRecord = {
      kind: 'mip-0018-s0-toolchain-spike',
      network: 'local',
      startedAt: '2026-01-01T00:00:00.000Z',
      toolchain: {},
      steps: {},
    };
    recorder(
      p,
      record,
    )((r) => {
      r.preflight = { nodeVersion: `2.1.101 (${TOKEN})` };
      r.steps.secondCall = { error: `ProviderError: at http://127.0.0.1:1/idx?project_id=${TOKEN}` };
      r.error = `IndexerError: fetch http://127.0.0.1:1/idx?project_id=abcdefgh5678 failed (${TOKEN})`;
    });
    const text = readFileSync(p, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('abcdefgh5678');
    expect((JSON.parse(text) as SpikeRecord).preflight).toEqual({ nodeVersion: '2.1.101 ([redacted])' });
  });
});
