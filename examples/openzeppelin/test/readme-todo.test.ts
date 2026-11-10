// SPDX-License-Identifier: Apache-2.0
//
// The README's TODO names every token module of the installed OpenZeppelin Compact Contracts package (`token/`,
// without the package's own `token/examples/`): each one is covered by an example, listed as open work, or listed as
// outside MIP-0018's token kinds — so a module added by a package update cannot go unmentioned.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..');

/** The installed package directory (hoisted to the repository root or kept in the workspace). */
function packageDir(): string {
  for (let d = join(import.meta.dirname, '..'); d !== dirname(d); d = dirname(d)) {
    const p = join(d, 'node_modules', '@openzeppelin', 'compact-contracts');
    if (existsSync(join(p, 'package.json'))) return p;
  }
  throw new Error('@openzeppelin/compact-contracts is not installed');
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('README TODO and the installed OpenZeppelin token modules', () => {
  const pkg = packageDir();
  const version = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string }).version;
  const modules = walk(join(pkg, 'token'))
    .filter((p) => p.endsWith('.compact') && !p.includes(`${join('token', 'examples')}`) && !/[/\\](test|mocks?)[/\\]/u.test(p))
    .map((p) => basename(p, '.compact'))
    .sort();
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  const todo = readme.slice(readme.indexOf('\n## TODO'), readme.indexOf('\n## ', readme.indexOf('\n## TODO') + 1));

  it('the TODO is about the installed version', () => {
    expect(todo).toContain(`OpenZeppelin Compact Contracts ${version}`);
    expect(modules.length).toBeGreaterThan(0);
  });

  it.each(modules)('%s is named in the TODO section', (m) => {
    expect(todo).toContain(`\`${m}\``);
  });

  it('NonFungibleToken and MultiToken are marked as outside MIP-0018 token kinds', () => {
    const outside = todo.slice(todo.indexOf('Outside MIP-0018'));
    for (const m of ['NonFungibleToken', 'MultiToken']) expect(outside).toContain(`\`${m}\``);
  });
});
