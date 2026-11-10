// SPDX-License-Identifier: Apache-2.0
//
// check-pins.mjs and secret-scan.mjs run against small fixture repositories (temporary directories with a copy of the
// tool): an image without a digest in a compose file or Dockerfile anywhere in the repository fails check-pins, and a
// mnemonic wrapped over several lines fails the secret scan; the clean fixtures pass.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const repo = join(import.meta.dirname, '..', '..');
const temps: string[] = [];
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));
const fixture = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'mip0018-repo-checks-'));
  temps.push(d);
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    cpSync(join(repo, f), join(d, f));
  }
  return d;
};
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const node = (root: string, tool: string, args: string[] = []) =>
  spawnSync(process.execPath, [join(root, 'tools', tool), ...args], { cwd: root, encoding: 'utf8' });

describe('check-pins: every image in every compose file and Dockerfile is pinned by digest', () => {
  const root = fixture([
    'tools/check-pins.mjs',
    'tools/lib/mip.mjs',
    'toolchain.json',
    'package.json',
    'docker/Dockerfile',
    'docker/local-stack/compose.yml',
  ]);
  // the install check reads node_modules: one copy of each npm pin at its pinned version
  const tc = JSON.parse(readFileSync(join(root, 'toolchain.json'), 'utf8')) as {
    npm: Record<string, string>;
    images: Record<string, string>;
  };
  for (const [name, version] of Object.entries(tc.npm))
    if (!name.startsWith('$')) put(root, join('node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  const node24 = tc.images.node!;
  // The image namespace, spelled so this file holds no image reference itself (check-pins scans tools/ too).
  const NS = ['midnight', 'ntwrk'].join('');

  it('the fixture passes', () => {
    const r = node(root, 'check-pins.mjs');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each([
    [
      'a tagged image without a digest in a compose file under examples/',
      'examples/stack/compose.yml',
      `services:\n  node:\n    image: ${NS}/midnight-node:2.1.101\n`,
      /examples\/stack\/compose\.yml:3: image midnightntwrk\/midnight-node:2\.1\.101 is not pinned by digest/u,
    ],
    [
      'an untagged image in a compose file under packages/',
      'packages/x/docker-compose.yaml',
      `services:\n  prover:\n    image: "${NS}/proof-server"\n`,
      /packages\/x\/docker-compose\.yaml:3: image midnightntwrk\/proof-server is not pinned by digest/u,
    ],
    [
      'a variable without a default as the image',
      'deployments/x/compose.yml',
      'services:\n  a:\n    image: ${PROVER_IMAGE}\n',
      /deployments\/x\/compose\.yml:3: image \$\{PROVER_IMAGE\} has a variable without a pinned default/u,
    ],
    [
      'a Dockerfile FROM without a digest under deployments/',
      'deployments/tools/Dockerfile',
      'FROM node:24-bookworm AS build\nFROM build\n',
      /deployments\/tools\/Dockerfile:1: image node:24-bookworm is not pinned by digest/u,
    ],
    [
      'a Dockerfile FROM through an ARG without a digest',
      'test-contracts/x/Dockerfile.tools',
      'ARG BASE=node:24\nFROM ${BASE}\n',
      /test-contracts\/x\/Dockerfile\.tools:2: image node:24 is not pinned by digest/u,
    ],
  ])('%s fails', (_name, path, text, message) => {
    put(root, path, text);
    try {
      const r = node(root, 'check-pins.mjs');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(message);
    } finally {
      rmSync(join(root, path));
    }
  });

  it('a digest-pinned image listed in toolchain.json passes in a compose file anywhere', () => {
    put(root, 'examples/stack/compose.yml', `services:\n  build:\n    image: ${node24}\n`);
    const r = node(root, 'check-pins.mjs');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('secret scan: a mnemonic wrapped over several lines is found', () => {
  const git = (root: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-C', root, ...args], { encoding: 'utf8' });
  const repoWith = (path: string, text: string) => {
    const root = fixture(['tools/secret-scan.mjs', 'tools/lib/mip.mjs', 'toolchain.json']);
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
    put(root, '.gitignore', 'node_modules\n');
    put(root, path, text);
    expect(git(root, 'init', '-q').status).toBe(0);
    git(root, 'add', '-A');
    expect(git(root, 'commit', '-q', '-m', 'fixture').status).toBe(0);
    return root;
  };
  // 24 words of the BIP-39 English list, four per line
  const words = Array.from({ length: 24 }, (_, i) => wordlist[(i * 211 + 7) % wordlist.length]!);
  const wrapped = words.reduce((a, w, i) => a + w + (i % 4 === 3 ? '\n' : ' '), '');

  it('a file without one passes', () => {
    const r = node(repoWith('notes.txt', 'nothing to see here\n'), 'secret-scan.mjs');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('four words per line over six lines fails, at the line of the first word', () => {
    const r = node(repoWith('notes.txt', `intro\n${wrapped}`), 'secret-scan.mjs');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL bip39-run at notes.txt:2');
  });

  it('the history scan finds it in the blob of a removed file', () => {
    const root = repoWith('notes.txt', `intro\n${wrapped}`);
    git(root, 'rm', '-q', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'remove');
    expect(node(root, 'secret-scan.mjs').status).toBe(0);
    const r = node(root, 'secret-scan.mjs', ['--history']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL bip39-run at history:[0-9a-f]{10}:notes\.txt:2/u);
  });
});
