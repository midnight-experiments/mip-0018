// Rule mutations: disabling any single MIP rule (decoder or reducer) makes at least one normative vector
// fail — or, for a rule the MIP's Testing list has no vector for (zero extension), at least one informative vector.
// The rule switches are internal test hooks; the public API always runs with every rule on.
import { loadVectors, runVectors } from '@mip0018/vectors/runner';
import { ALL_CODEC_RULES, type CodecRules } from '@mip0018/codec/internal';
import { afterAll, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/adapter.ts';
import { ALL_CONSUMER_RULES, type ConsumerRules } from '../src/internal.ts';

const normative = loadVectors({ informative: false });
const zeroExtension = loadVectors().filter((v) => v.entry.testId === 'INF-ZEXT');
const summary: string[] = [];

/**
 * Rules the MIP's Testing list has no vector for, with the informative vectors that catch them instead.
 * `zeroExtend` (MIP "Consuming": missing trailing bytes are zero) is caught by `informative/zero-extension`.
 */
const INFORMATIVE_ONLY: Partial<Record<keyof CodecRules, typeof zeroExtension>> = { zeroExtend: zeroExtension };

async function failing(opts: { rules?: Partial<ConsumerRules>; codecRules?: Partial<CodecRules> }, vectors = normative): Promise<string[]> {
  const report = await runVectors(vectors, async (req) => handleRequest(req, opts));
  return report.results.filter((r) => !r.ok).map((r) => r.id);
}

describe('rule mutations', () => {
  it('baseline: with every rule on, no normative vector fails', async () => {
    expect(await failing({})).toEqual([]);
  });

  for (const rule of Object.keys(ALL_CODEC_RULES) as Array<keyof CodecRules>) {
    const informative = INFORMATIVE_ONLY[rule];
    if (informative !== undefined) {
      it(`decoder rule "${rule}" disabled → no normative vector notices, at least one informative zero-extension vector fails`, async () => {
        expect(await failing({ codecRules: { [rule]: false } })).toEqual([]);
        const ids = await failing({ codecRules: { [rule]: false } }, informative);
        summary.push(`codec.${rule} (informative vectors): ${ids.length} — ${ids.join(' ')}`);
        expect(ids.length).toBeGreaterThan(0);
      });
      continue;
    }
    it(`decoder rule "${rule}" disabled → at least one normative vector fails`, async () => {
      const ids = await failing({ codecRules: { [rule]: false } });
      summary.push(`codec.${rule}: ${ids.length} — ${ids.join(' ')}`);
      expect(ids.length).toBeGreaterThan(0);
    });
  }

  for (const rule of Object.keys(ALL_CONSUMER_RULES) as Array<keyof ConsumerRules>) {
    it(`reducer rule "${rule}" disabled → at least one normative vector fails`, async () => {
      const ids = await failing({ rules: { [rule]: false } });
      summary.push(`consumer.${rule}: ${ids.length} — ${ids.join(' ')}`);
      expect(ids.length).toBeGreaterThan(0);
    });
  }

  // Two wrong tombstone rules (MIP "Applying records") and the vectors that must catch them.
  // S1a cannot catch the first: its event touches one key only (name = "A", Null at name, name = "B").
  it('mutation tombstoneIdentityWide (a Null record at any key deletes every field of the identity) fails S3a, S3b, S4a, S9d', async () => {
    expect(await failing({ rules: { tombstonePerKey: false } })).toEqual(['S3a', 'S3b', 'S4a', 'S9d']);
  });
  it('mutation keepEmptyIdentity (an identity whose last field was deleted is still reported, without fields) fails S3c, S4b', async () => {
    expect(await failing({ rules: { removeEmptyIdentity: false } })).toEqual(['S3c', 'S4b']);
  });

  afterAll(() => {
    console.log(`rule mutations (${summary.length}):\n${summary.join('\n')}`);
  });
});
