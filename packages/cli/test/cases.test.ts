// SPDX-License-Identifier: Apache-2.0
//
// The case folders (deployments/<network>/cases) are generated from the examples' metadata.json and the vectors by
// deployments/tools/prepare-cases.ts --network <id>: committed folders must equal what it generates, the generator is
// deterministic for every public network, and every step uses only the documented placeholders and an existing
// mip0018 command.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..');
const tool = join(repo, 'deployments', 'tools', 'prepare-cases.ts');
const NETWORKS = ['preview', 'preprod', 'mainnet'] as const;
const IDS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C12', 'IDX', 'U1'];
const prepare = (...args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });

const tmp = mkdtempSync(join(tmpdir(), 'mip0018-cases-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const generated = Object.fromEntries(
  NETWORKS.map((n) => {
    const dir = join(tmp, n);
    const r = prepare('--network', n, '--dir', dir);
    if (r.status !== 0) throw new Error(`prepare-cases --network ${n}: ${r.stderr}`);
    return [n, dir];
  }),
) as Record<(typeof NETWORKS)[number], string>;
const ids = readdirSync(generated.preview, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const cases = generated.preview;

describe('case folders', () => {
  it('the generator writes C01–C10, C12, IDX, U1 for every public network, deterministically', () => {
    expect(ids).toEqual(IDS);
    for (const n of NETWORKS) {
      const r = prepare('--network', n, '--dir', generated[n], '--check');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const c = JSON.parse(readFileSync(join(generated[n], 'C06', 'case.json'), 'utf8')) as { placeholders: Record<string, string> };
      expect(c.placeholders['{net}']).toContain(`--network ${n}`);
      expect(readFileSync(join(generated[n], 'C06', 'README.md'), 'utf8')).toContain(
        `recheck --network ${n} --case deployments/${n}/cases/C06`,
      );
    }
  });

  it('preprod and mainnet commands pass the Blockfrost token variable by name; preview needs none', () => {
    expect(readFileSync(join(generated.preprod, 'C01', 'README.md'), 'utf8')).toMatch(/-e MIP0018_BLOCKFROST_PREPROD[" ]/u);
    expect(readFileSync(join(generated.mainnet, 'C01', 'README.md'), 'utf8')).toMatch(/-e MIP0018_BLOCKFROST_MAINNET[" ]/u);
    expect(readFileSync(join(generated.preview, 'C01', 'README.md'), 'utf8')).not.toMatch(/BLOCKFROST/u);
  });

  it('an unknown network is refused', () => {
    const r = prepare('--network', 'undeployed', '--dir', join(tmp, 'x'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--network <preview\|preprod\|mainnet>/u);
  });

  it('a case README shows each list command as it ran, the block its observation was read at, and the --to-block re-read', () => {
    const preview = join(repo, 'deployments', 'preview', 'cases');
    if (!existsSync(preview)) return;
    // Regenerate a copy of the committed folders (records and observations included) and read what the generator writes.
    const copy = join(tmp, 'readme-copy');
    cpSync(preview, copy, { recursive: true });
    const r = prepare('--network', 'preview', '--dir', copy);
    expect(r.status).toBe(0);
    let checked = 0;
    for (const id of ids) {
      const c = JSON.parse(readFileSync(join(copy, id, 'case.json'), 'utf8')) as {
        steps: { id: string; argv: string[]; stdout?: string }[];
        recheck: { list?: { record: string; expect: string; atStep?: string }[] };
      };
      const readme = readFileSync(join(copy, id, 'README.md'), 'utf8').split('\n');
      const rec = existsSync(join(copy, id, 'record.json'))
        ? (JSON.parse(readFileSync(join(copy, id, 'record.json'), 'utf8')) as { steps: { id: string; inclusion?: { height: number } }[] })
        : undefined;
      for (const s of c.steps) {
        if (s.argv[0] !== 'list' || s.stdout === undefined || !existsSync(join(copy, id, s.stdout))) continue;
        const expectFile = s.argv[s.argv.indexOf('--expect') + 1]?.replace(/^@\{case\}\//u, '');
        const at = c.recheck.list?.find((l) => l.record === 'record.json' && l.expect === expectFile)?.atStep;
        if (at === undefined) continue;
        const height = rec?.steps.find((x) => x.id === at)?.inclusion?.height;
        const readAt = (JSON.parse(readFileSync(join(copy, id, s.stdout), 'utf8')) as { snapshot: { toBlock: number } }).snapshot.toBlock;
        // the steps table: the command as it ran (case.json has no --to-block), writing the committed observation
        const row = readme.find((l) => l.match(new RegExp(`^\\| \\d+ \\| \`${s.id}\``, 'u')));
        expect(row, `${id} ${s.id}`).toBeDefined();
        expect(row).toContain(`> deployments/preview/cases/${id}/${s.stdout}`);
        expect(row).not.toContain('--to-block');
        // the re-read table: the block the observation was read at, the step's block, and --to-block <that block>
        const reread = readme.find((l) => l.startsWith(`| \`${s.id}\` |`));
        expect(reread, `${id} ${s.id}`).toBeDefined();
        expect(reread).toContain(`(${readAt})`);
        expect(reread).toContain(`| ${height} |`);
        expect(reread).toContain(`--to-block ${height} --json\``);
        checked++;
      }
    }
    expect(checked).toBe(12); // C06: 5, C07: 1, C12: 6
  });

  it('committed case folders equal the generator', () => {
    for (const n of NETWORKS) {
      if (!existsSync(join(repo, 'deployments', n, 'cases'))) continue;
      const r = prepare('--network', n, '--check');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
  });

  it.each(ids)(
    '%s: one mip0018 command (or wallet-free repository script) per step, documented placeholders only, an expected exit code',
    (id) => {
      const c = JSON.parse(readFileSync(join(cases, id, 'case.json'), 'utf8')) as {
        steps: { id: string; runner: string; script?: string; argv: string[]; expectExit: number; expectOutput?: string }[];
        recheck: Record<string, unknown[]>;
      };
      const commands = [
        'deploy',
        'publish',
        'call',
        'remove-circuit',
        'deploy-and-publish',
        'upgrade',
        'wallet',
        'check-event',
        'list',
        'index',
        'lookup',
      ];
      const signing = ['deploy', 'publish', 'call', 'remove-circuit', 'deploy-and-publish', 'upgrade', 'wallet'];
      const known = /^\{(net|signer|signer2|case|out|out:[A-Z0-9]+|firstHeight|lastHeight)\}$/u;
      expect(new Set(c.steps.map((s) => s.id)).size).toBe(c.steps.length);
      for (const s of c.steps) {
        if (s.script) {
          // a wallet-free repository script (e.g. the upgrade template's inspect.ts): never a signer, never a placeholder
          // that carries signer options
          expect(s.script).toMatch(/^examples\/[\w./-]+\.ts$/u);
          expect(s.runner).toBe('wallet-free');
          expect(s.argv.some((a) => a === '{signer}' || a === '{signer2}')).toBe(false);
        } else {
          expect(commands).toContain(s.argv[0]);
          expect(s.runner === 'signer').toBe(signing.includes(s.argv[0]!));
        }
        expect([0, 1, 3]).toContain(s.expectExit);
        // a step that must fail names the reason it must fail for
        expect(s.expectExit === 0 || (s.expectOutput ?? '').length > 0).toBe(true);
        for (const a of s.argv) for (const m of a.match(/\{[^}"]*\}/gu) ?? []) expect(m).toMatch(known);
      }
      expect(Object.values(c.recheck).flat().length).toBeGreaterThan(0);
    },
  );
});
