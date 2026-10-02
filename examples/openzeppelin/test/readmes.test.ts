// SPDX-License-Identifier: Apache-2.0
//
// The "add these lines" blocks of the OpenZeppelin example READMEs equal the sources
// (scripts/check-readmes.ts in test form, so CI runs it), and the diff tool itself is sound.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_NAMES, OZ_DIR } from '../src/examples.ts';
import { checkReadme, unifiedDiff } from '../src/readme-diff.ts';

describe('README diffs and snippets', () => {
  it.each(['README.md', ...EXAMPLE_NAMES.map((e) => `${e}/README.md`)])('%s matches the sources', (readme) => {
    const path = join(OZ_DIR, readme);
    expect(existsSync(path)).toBe(true);
    const { problems, blocks } = checkReadme(path);
    expect(problems).toEqual([]);
    expect(blocks).toBeGreaterThan(0);
  });

  it('unifiedDiff: additions with context, merged hunks, no change = empty', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const b = ['a', 'b', 'X', 'c', 'd', 'e', 'f', 'g', 'Y', 'h'];
    expect(unifiedDiff(a, b, 1)).toBe(['@@ -2,2 +2,3 @@', ' b', '+X', ' c', '@@ -7,2 +8,3 @@', ' g', '+Y', ' h'].join('\n'));
    expect(unifiedDiff(a, b, 3)).toBe(['@@ -1,8 +1,10 @@', ' a', ' b', '+X', ' c', ' d', ' e', ' f', ' g', '+Y', ' h'].join('\n'));
    expect(unifiedDiff(['x', 'y'], ['x', 'z'], 1)).toBe(['@@ -1,2 +1,2 @@', ' x', '-y', '+z'].join('\n'));
    expect(unifiedDiff(a, a)).toBe('');
  });
});
