// SPDX-License-Identifier: Apache-2.0
//
// The Stagenet case folders (deployments/stagenet/cases) are generated from the examples' metadata.json and the
// vectors by deployments/stagenet/tools/prepare-cases.ts: the committed files must equal what it generates, and
// every step must use only the documented placeholders and an existing mip0018 command.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..');
const cases = join(repo, 'deployments', 'stagenet', 'cases');
const ids = readdirSync(cases, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('Stagenet case folders', () => {
  it('are up to date with the generator (C01–C10, IDX)', () => {
    expect(ids).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'IDX']);
    const r = spawnSync(process.execPath, [join(repo, 'deployments', 'stagenet', 'tools', 'prepare-cases.ts'), '--check'], {
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each(ids)('%s: one mip0018 command per step, documented placeholders only, an expected exit code', (id) => {
    const c = JSON.parse(readFileSync(join(cases, id, 'case.json'), 'utf8')) as {
      steps: { id: string; runner: string; argv: string[]; expectExit: number; expectOutput?: string }[];
      recheck: Record<string, unknown[]>;
    };
    const commands = ['deploy', 'publish', 'call', 'remove-circuit', 'deploy-and-publish', 'wallet', 'verify', 'list', 'index', 'lookup'];
    const known = /^\{(net|signer|signer2|case|out|out:[A-Z0-9]+|firstHeight|lastHeight)\}$/u;
    expect(new Set(c.steps.map((s) => s.id)).size).toBe(c.steps.length);
    for (const s of c.steps) {
      expect(commands).toContain(s.argv[0]);
      expect([0, 1, 3]).toContain(s.expectExit);
      // a step that must fail names the reason it must fail for
      expect(s.expectExit === 0 || (s.expectOutput ?? '').length > 0).toBe(true);
      expect(s.runner === 'signer').toBe(
        ['deploy', 'publish', 'call', 'remove-circuit', 'deploy-and-publish', 'wallet'].includes(s.argv[0]!),
      );
      for (const a of s.argv) for (const m of a.match(/\{[^}"]*\}/gu) ?? []) expect(m).toMatch(known);
    }
    expect(Object.values(c.recheck).flat().length).toBeGreaterThan(0);
  });
});
