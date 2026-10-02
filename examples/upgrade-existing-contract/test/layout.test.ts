// SPDX-License-Identifier: Apache-2.0
//
// Testing row "Layout check": scripts/check-layout.ts passes for the real pair and FAILS when a ledger field of the
// upgrade source is reordered, renamed, retyped, dropped or added (or a module that declares ledger fields is
// imported). Each mutation is a copy of upgrade/LegacyTokenMetadata.compact in a temporary directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareLayouts, layoutOfSource, type Layout } from '@mip0018/midnight';
import { LEGACY, UPGRADE } from '../src/contracts.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-layout.ts');
const MODULE = join(ROOT, 'packages', 'compact', 'src', 'Mip0018');
const MINIMAL_TOKEN = join(ROOT, 'examples', 'minimal', 'contracts', 'MinimalToken');
const tmp = mkdtempSync(join(tmpdir(), 'mip0018-layout-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The upgrade source with its module import made absolute, so copies compile from the temporary directory.
const original = readFileSync(UPGRADE.source, 'utf8').replace('"../../../packages/compact/src/Mip0018"', JSON.stringify(MODULE));
const DOMAIN = 'export sealed ledger domain: Bytes<32>;';
const OWNER = 'export ledger owner: Bytes<32>;';
const TOTAL = 'export ledger totalMinted: Uint<128>;';
const COUNT = 'export ledger mintCount: Counter;';
for (const line of [DOMAIN, OWNER, TOTAL, COUNT]) if (!original.includes(line)) throw new Error(`fixture drift: ${line}`);

const swap = (s: string, a: string, b: string) => s.replace(a, '\u0000').replace(b, a).replace('\u0000', b);
const write = (name: string, text: string) => {
  const f = join(tmp, `${name}.compact`);
  writeFileSync(f, text);
  return f;
};

let legacy: Layout | undefined;
const legacyLayout = () => (legacy ??= layoutOfSource(LEGACY.source));
const check = (name: string, text: string) => compareLayouts(legacyLayout(), layoutOfSource(write(name, text)));
const script = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('ledger layout check', () => {
  it('the real pair is identical (4 fields, same compiler)', () => {
    const c = check('Same', original);
    expect(c.problems).toEqual([]);
    expect(c.identical).toBe(true);
    expect(c.rows.map((r) => r.legacy)).toEqual([
      'domain: Cell<Bytes<32>>',
      'owner: Cell<Bytes<32>>',
      'totalMinted: Cell<Uint<128>>',
      'mintCount: Counter',
    ]);
  });

  const mutations: [string, string, RegExp][] = [
    ['reordered (owner ↔ totalMinted)', swap(original, OWNER, TOTAL), /#1: deployed owner: Cell<Bytes<32>>, upgrade totalMinted/u],
    ['reordered, same type (domain ↔ owner)', swap(original, DOMAIN, OWNER), /#0: renamed \(domain → owner\)/u],
    [
      'renamed (owner → admin)',
      original.replace(OWNER, 'export ledger admin: Bytes<32>;').replace(/== owner,/u, '== admin,'),
      /renamed \(owner → admin\)/u,
    ],
    [
      'retyped (totalMinted Uint<128> → Uint<64>)',
      original.replace(TOTAL, 'export ledger totalMinted: Uint<64>;'),
      /#2: deployed totalMinted: Cell<Uint<128>>, upgrade totalMinted: Cell<Uint<64>>/u,
    ],
    [
      'other storage (mintCount Counter → Cell)',
      original.replace(COUNT, 'export ledger mintCount: Uint<64>;'),
      /#3: deployed mintCount: Counter, upgrade mintCount: Cell<Uint<64>>/u,
    ],
    ['dropped (mintCount)', original.replace(COUNT, ''), /#3: the upgrade lacks the deployed field mintCount: Counter/u],
    [
      'extra field appended',
      original.replace(COUNT, `${COUNT}\nexport ledger published: Boolean;`),
      /#4: the upgrade declares an extra field published: Cell<Boolean>/u,
    ],
    [
      'extra field first (a publish-once flag)',
      original.replace(DOMAIN, `export ledger published: Boolean;\n${DOMAIN}`),
      /#0: deployed domain: Cell<Bytes<32>>, upgrade published: Cell<Boolean>/u,
    ],
    [
      'a module with ledger fields imported before the fields',
      original.replace(DOMAIN, `import ${JSON.stringify(MINIMAL_TOKEN)} prefix Extra_;\n${DOMAIN}`),
      /#0: deployed domain: Cell<Bytes<32>>, upgrade balances: Map<Bytes<32>, Uint<64>>/u,
    ],
  ];
  for (const [what, text, problem] of mutations) {
    it(`fails: ${what}`, () => {
      const c = check(what.replace(/\W+/gu, '_'), text);
      expect(c.identical).toBe(false);
      expect(c.problems.join('\n')).toMatch(problem);
    });
  }

  it('`export` and `sealed` do not change the layout (reported as a note only)', () => {
    const c = check('Modifiers', original.replace(DOMAIN, 'ledger domain: Bytes<32>;'));
    expect(c.identical).toBe(true);
    expect(c.notes.join('\n')).toMatch(/#0 domain: exported true vs false/u);
  });

  it('the script exits 0 for the real pair, 1 for a reordered copy, 2 for a source that does not compile', () => {
    const ok = script();
    expect(ok.stdout).toMatch(/OK: identical ledger layout \(4 fields\)/u);
    expect(ok.status).toBe(0);
    const bad = script('--upgrade', write('Reordered', swap(original, OWNER, TOTAL)));
    expect(bad.stdout).toMatch(/LAYOUT MISMATCH #1/u);
    expect(bad.stdout).toMatch(/FAILED/u);
    expect(bad.status).toBe(1);
    expect(script('--upgrade', write('Broken', `${original}\nthis is not Compact`)).status).toBe(2);
  });
});
