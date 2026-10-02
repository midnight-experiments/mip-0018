// SC-001 rule mutations: disabling any single MIP rule (decoder or reducer) makes at least one normative vector
// fail. The rule switches are internal test hooks; the public API always runs with every rule on.
import { loadVectors, runVectors } from '@mip0018/vectors/runner';
import { ALL_CODEC_RULES, type CodecRules } from '@mip0018/codec/internal';
import { afterAll, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/adapter.ts';
import { ALL_CONSUMER_RULES, type ConsumerRules } from '../src/internal.ts';

const normative = loadVectors({ informative: false });
const summary: string[] = [];

async function failing(opts: { rules?: Partial<ConsumerRules>; codecRules?: Partial<CodecRules> }): Promise<string[]> {
  const report = await runVectors(normative, async (req) => handleRequest(req, opts));
  return report.results.filter((r) => !r.ok).map((r) => r.id);
}

describe('rule mutations', () => {
  it('baseline: with every rule on, no normative vector fails', async () => {
    expect(await failing({})).toEqual([]);
  });

  for (const rule of Object.keys(ALL_CODEC_RULES) as Array<keyof CodecRules>) {
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

  afterAll(() => {
    console.log(`rule mutations (${summary.length}):\n${summary.join('\n')}`);
  });
});
