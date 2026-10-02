// valType 4: RFC 3986 `URI` as ERC-721 uses it (Q20). The 26 F1 investigation cases, extra grammar cases, and a
// timing guard against pathological backtracking.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR } from '@mip0018/vectors/common';
import { describe, expect, it } from 'vitest';
import { checkValue, isRfc3986Uri } from '../src/index.ts';

const verdicts = JSON.parse(readFileSync(join(VECTORS_DIR, 'informative/uri/verdicts.json'), 'utf8')) as {
  cases: Array<{ case: string; value: string; verdict: 'accept' | 'reject' }>;
};

describe('the 26 investigation cases', () => {
  it('has 16 accepts and 10 rejects', () => {
    expect(verdicts.cases.filter((c) => c.verdict === 'accept').length).toBe(16);
    expect(verdicts.cases.length).toBe(26);
  });
  for (const c of verdicts.cases) {
    it(`${c.case} ${JSON.stringify(c.value)} → ${c.verdict}`, () => {
      expect(isRfc3986Uri(c.value)).toBe(c.verdict === 'accept');
      expect(checkValue(4, new TextEncoder().encode(c.value))).toBe(c.verdict === 'accept' ? undefined : 'invalid-uri');
    });
  }
});

describe('grammar', () => {
  it.each([
    'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/1.json',
    'https://acme.example:443/a/b?x=1&y=2#frag',
    'https://192.168.0.1/',
    'https://[2001:db8::7]/x',
    'https://[v1.fe]/',
    'http://[V7.abc]/', // ABNF literals are case-insensitive: IPvFuture may start with "V" (audit F-N1)
    'urn:uuid:6e8bc430-9c3a-11d9-9669-0800200c9a66',
    'did:example:123456789abcdefghi',
    'a+b-c.d:x',
    'https://acme.example/%E2%82%AC',
  ])('accepts %s', (s) => expect(isRfc3986Uri(s)).toBe(true));
  it.each([
    '1http://x',
    ':nope',
    'http://acme.example/\n',
    'http://acme.example/ ',
    'https://[::1/',
    'https://acme.example/#a#b',
    'https://acme.example/<x>',
    'https://acme.example/"q"',
    'https://ac me.example/',
    'https://acme.example/%2',
  ])('rejects %j', (s) => expect(isRfc3986Uri(s)).toBe(false));
});

describe('no pathological backtracking (219-character inputs)', () => {
  const adversarial = [
    'a://' + 'a'.repeat(214) + '\u0000',
    'a://' + '%41'.repeat(71) + '%',
    'a:' + '/'.repeat(216) + ' ',
    'a://' + ':'.repeat(214) + '#',
    'a://' + '@'.repeat(214) + '[',
    'a://[' + '1:'.repeat(106) + 'x',
    'a://' + 'a@'.repeat(107) + '\\',
    'a:' + '?'.repeat(216) + '%',
    'a://' + '1.'.repeat(107) + '\u0000',
    'a://' + 'v1.'.repeat(71) + ']',
  ];
  for (const s of adversarial) {
    it(`${JSON.stringify(s.slice(0, 16))}… (${s.length} chars) decides in < 20 ms`, () => {
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) isRfc3986Uri(s);
      expect((performance.now() - t0) / 10).toBeLessThan(20);
    });
  }
});
