// The committed fixtures equal the independent generator's output (byte for byte), and SHA256SUMS is current.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VECTORS_DIR, verifySums } from '../tools/common.ts';

describe('generator reproducibility', () => {
  it('generate.ts --check finds no difference', () => {
    const r = spawnSync(process.execPath, [join(VECTORS_DIR, 'tools/generate.ts'), '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/vectors --check: OK/);
  });

  it('SHA256SUMS matches every pinned file', () => {
    expect(verifySums()).toEqual([]);
  });
});
