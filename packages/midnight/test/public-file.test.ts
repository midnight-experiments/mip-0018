// SPDX-License-Identifier: Apache-2.0
//
// The public-file writer (public-file.ts, `publicCopy` in redact.ts): published values keep every byte but a
// registered token, messages lose URL query strings and credentials, every other string loses the credentials of a
// URL's authority and `project_id` values, the value itself is never changed, and the result is a fixed point. The
// committed network file and scanner states written again through it keep their bytes (apart from `updatedAt`).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicJsonText } from '../src/public-file.ts';
import { publicCopy, registerSecret } from '../src/redact.ts';
import { SCAN_STATE_RULES } from '../src/scanner.ts';

const TOKEN = 'FakeTokenPublicCopy0123456789';
registerSecret(TOKEN);
const rules = { exact: [['args']], messages: [['error'], ['steps', '*', 'note']] } as const;

describe('publicCopy', () => {
  const value = {
    args: ['https://u:p@h.example/x?owner=a@b.example', { project_id: 'published' }, `t-${TOKEN}`],
    error: `failed at https://u:p@h.example/x?project_id=${TOKEN}#f`,
    steps: [{ note: 'see wss://h.example/ws?project_id=abcdefgh1234', other: 'https://a:b@c@h.example/p?q=1' }],
    data: { project_id: 'abcdefgh1234', url: 'https://images.example?owner=alice@example.org', bytes: new Uint8Array([1, 2]), n: 5n },
  };

  it('applies the rules by path and leaves the value unchanged', () => {
    const before = structuredClone(value);
    const c = publicCopy(value, rules);
    expect(value).toEqual(before);
    expect(c.args).toEqual(['https://u:p@h.example/x?owner=a@b.example', { project_id: 'published' }, 't-[redacted]']);
    expect(c.error).toBe('failed at https://h.example/x');
    expect(c.steps[0]).toEqual({ note: 'see wss://h.example/ws', other: 'https://h.example/p?q=1' });
    expect(c.data.project_id).toBe('[redacted]');
    expect(c.data.url).toBe('https://images.example?owner=alice@example.org');
    expect(c.data.bytes).toBe(value.data.bytes);
    expect(c.data.n).toBe(5n);
  });

  it('is a fixed point', () => {
    const once = publicCopy(value, rules);
    expect(publicCopy(once, rules)).toEqual(once);
  });
});

describe('committed public files written again keep their bytes', () => {
  const preview = join(import.meta.dirname, '..', '..', '..', 'deployments', 'preview');
  const stamp = (t: string) => t.replace(/"updatedAt": "[^"]*"/u, '"updatedAt": "-"');

  it('the preview network file', () => {
    const text = readFileSync(join(preview, 'network.json'), 'utf8');
    expect(
      publicJsonText(JSON.parse(text), {
        messages: [
          ['network', 'indexer'],
          ['network', 'indexerWs'],
          ['network', 'rpc'],
        ],
      }),
    ).toBe(text);
  });

  it('every committed scanner state', () => {
    const states = readdirSync(join(preview, 'cases'))
      .map((c) => join(preview, 'cases', c, 'index', 'index-state.json'))
      .filter((p) => {
        try {
          return readFileSync(p).length > 0;
        } catch {
          return false;
        }
      });
    expect(states.length).toBeGreaterThanOrEqual(2);
    for (const p of states) {
      const text = readFileSync(p, 'utf8');
      expect(stamp(publicJsonText(JSON.parse(text), { ...SCAN_STATE_RULES, indent: 1 })), p).toBe(stamp(text));
    }
  });
});
