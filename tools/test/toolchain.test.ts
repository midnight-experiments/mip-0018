// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const toolchain = JSON.parse(readFileSync(join(root, 'toolchain.json'), 'utf8'));

describe('toolchain.json', () => {
  it('pins Compact 0.35.0 with ZKIR v3', () => {
    expect(toolchain.compact.version).toBe('0.35.0');
    expect(toolchain.compact.flags).toContain('--feature-zkir-v3');
  });

  it('pins every image by digest, from midnightntwrk/* or node only', () => {
    for (const [key, ref] of Object.entries(toolchain.images)) {
      if (key.startsWith('$')) continue;
      expect(ref).toMatch(/^(midnightntwrk\/[a-z0-9-]+|node):[\w.-]+@sha256:[0-9a-f]{64}$/u);
    }
  });

  it('pins the MIP text by commit and SHA-256 and links PR #340', () => {
    expect(toolchain.mip.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(toolchain.mip.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(toolchain.mip.url).toContain(toolchain.mip.commit);
    expect(toolchain.mip.pullRequest).toBe('https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340');
  });

  it('keeps the spike compiler on the same pins as the Docker image', () => {
    const script = readFileSync(join(root, 'test-contracts', 'toolchain-spike', 'scripts', 'compile.sh'), 'utf8');
    expect(script).toContain('--feature-zkir-v3');
    expect(script).toContain(`want="${toolchain.compact.version}"`);
  });
});
