// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { extractRequirements, normalize, sentences } from '../lib/requirements.mjs';

describe('MIP requirement extraction', () => {
  it('splits sentences without breaking abbreviations', () => {
    expect(sentences('A value, e.g. a URI, is data. Consumers MUST check it.')).toEqual([
      'A value, e.g. a URI, is data.',
      'Consumers MUST check it.',
    ]);
  });

  it('keeps only MUST/SHOULD sentences, with their section and level', () => {
    const md = [
      '# Title',
      '## Specification',
      'The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119.',
      '### Payload',
      'Bytes are bytes. A consumer MUST check a payload. Emitters may do anything.',
      '- Keys SHOULD be UTF-8, but consumers MUST NOT reject an event because a key is not UTF-8.',
      '```',
      'code MUST be ignored',
      '```',
      '| `name` | UTF-8 string (1), not empty | SHOULD | Display name. |',
    ].join('\n');
    const reqs = extractRequirements(md);
    expect(reqs.map((r) => [r.id, r.section, r.level, r.text])).toEqual([
      ['C-001', 'Specification > Payload', 'MUST', 'A consumer MUST check a payload.'],
      ['C-002', 'Specification > Payload', 'MUST/SHOULD', 'Keys SHOULD be UTF-8, but consumers MUST NOT reject an event because a key is not UTF-8.'],
      ['C-003', 'Specification > Payload', 'SHOULD', '| `name` | UTF-8 string (1), not empty | SHOULD | Display name. |'],
    ]);
  });

  it('normalizes whitespace and escaped pipes', () => {
    expect(normalize('  a \\| b\n c ')).toBe('a | b c');
  });
});
