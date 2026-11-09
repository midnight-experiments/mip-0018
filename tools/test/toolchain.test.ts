// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const toolchain = JSON.parse(readFileSync(join(root, 'toolchain.json'), 'utf8'));

describe('toolchain.json', () => {
  it('pins Compact 0.36.0 with no compiler flags (ZKIR v3 is its only backend)', () => {
    expect(toolchain.compact.version).toBe('0.36.0');
    expect(toolchain.compact.language).toBe('0.28.0');
    expect(toolchain.compact.runtime).toBe('0.21.0');
    expect(toolchain.compact).not.toHaveProperty('flags');
  });

  it('pins one proof server and the ledger node 2.1.101 runs (ledger-v9 1.0.1, onchain-runtime-v4 4.0.1)', () => {
    expect(
      Object.keys(toolchain.images)
        .filter((k) => !k.startsWith('$'))
        .sort(),
    ).toEqual(['indexer', 'midnightNode', 'node', 'proofServer'].sort());
    expect(toolchain.images.midnightNode).toMatch(/^midnightntwrk\/midnight-node:2\.1\.101@/u);
    expect(toolchain.images.indexer).toMatch(/^midnightntwrk\/indexer-standalone:4\.4\.101@/u);
    expect(toolchain.images.proofServer).toMatch(/^midnightntwrk\/proof-server:9\.0\.\d+@/u);
    expect(toolchain.npm['@midnightntwrk/ledger-v9']).toBe('1.0.1');
    expect(toolchain.npm['@midnightntwrk/onchain-runtime-v4']).toBe('4.0.1');
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const name of ['@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4', '@midnight-ntwrk/compact-runtime'])
      expect(rootPkg.overrides[name]).toBe(toolchain.npm[name]);
  });

  it('pins every image by digest, from midnightntwrk/* or node only', () => {
    for (const [key, ref] of Object.entries(toolchain.images)) {
      if (key.startsWith('$')) continue;
      expect(ref).toMatch(/^(midnightntwrk\/[a-z0-9-]+|node):[\w.-]+@sha256:[0-9a-f]{64}$/u);
    }
  });

  it('pins the MIP text by commit and SHA-256 and links PR #372', () => {
    expect(toolchain.mip.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(toolchain.mip.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(toolchain.mip.url).toContain(toolchain.mip.commit);
    expect(toolchain.mip.pullRequest).toBe('https://github.com/midnightntwrk/midnight-improvement-proposals/pull/372');
  });

  it('keeps the spike compiler on the same pins as the Docker image', () => {
    const script = readFileSync(join(root, 'test-contracts', 'toolchain-spike', 'scripts', 'compile.sh'), 'utf8');
    expect(script).not.toContain('--feature');
    expect(script).toContain(`want="${toolchain.compact.version}"`);
  });
});
