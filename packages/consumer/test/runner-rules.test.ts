// The runner's comparison rules (vectors/README.md, "Runner contract") applied to the reference consumer's real
// responses, changed the way another conforming — or non-conforming — consumer would answer:
//   - MIP Testing S9 (since 78ecbb4): "Grouping is a SHOULD, so two outcomes are valid: no groups at all, or exactly the
//     following groups" — a consumer without groups passes; one that groups wrongly fails;
//   - MIP Testing S8: "A consumer that displays amounts …" — a consumer without display passes (not applicable);
//   - MIP Consuming: "Indexers MAY index only some tokens or keys" — keys other than the four common keys are
//     optional; a missing common key fails.
import { loadVectors, runVectors, type Json } from '@mip0018/vectors/runner';
import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/adapter.ts';

const normative = loadVectors({ informative: false });
const COMMON = new Set(['6e616d65', '73796d626f6c', '646563696d616c73', '7374616e6461726473']);

/** The reference consumer with its state responses rewritten by `edit`. */
const consumer = (edit: (res: Json, req: Json) => Json) => async (req: Json) => {
  const res = handleRequest(req);
  return req.op === 'state' && typeof res.error !== 'string' ? edit(structuredClone(res), req) : res;
};
const failed = (r: Awaited<ReturnType<typeof runVectors>>) => r.results.filter((x) => !x.ok).map((x) => x.id);

describe('runner rules on the reference consumer’s responses', () => {
  it('the reference consumer reports single-member groups too; they are not compared', async () => {
    const s9a = normative.find((v) => v.entry.id === 'S9a')!;
    const res = handleRequest({ id: 'S9a', op: 'state', steps: s9a.data.steps });
    const sizes = (res.groups as Json[]).map((g) => (g.members as unknown[]).length).sort();
    expect(sizes).toEqual([1, 1, 1, 1, 3]); // ACME (3) + bbbb, testnet-b, acme, " ACME"
    const r = await runVectors(normative, async (req) => handleRequest(req));
    expect(r.normative).toEqual({ passed: 67, total: 67 });
    expect(r.notApplicable).toEqual({});
  });

  it('a consumer that does not group symbols passes S9 (no groups at all), the group check not applicable', async () => {
    for (const edit of [
      (res: Json) => ({ ...res, groups: [] }),
      (res: Json) => {
        delete res.groups;
        return res;
      },
    ]) {
      const r = await runVectors(normative, consumer(edit));
      expect(failed(r)).toEqual([]);
      expect(Object.keys(r.notApplicable).sort()).toEqual(['S9a', 'S9b', 'S9c', 'S9d']);
    }
  });

  it('a consumer that groups wrongly fails S9', async () => {
    // Adds the identity whose symbol is "acme" (other bytes) to the ACME group: symbols are compared as exact bytes.
    const r = await runVectors(
      normative,
      consumer((res) => {
        const groups = (res.groups ?? []) as Json[];
        const main = groups.find((g) => g.symbol_hex === '41434d45' && g.contractAddress === 'aa'.repeat(32) && g.network === 'testnet-a');
        const lower = groups.find((g) => g.symbol_hex === '61636d65');
        if (main !== undefined && lower !== undefined) main.members = [...(main.members as Json[]), ...(lower.members as Json[])];
        return res;
      }),
    );
    expect(failed(r)).toEqual(['S9a', 'S9b', 'S9c', 'S9d']);
    // Merges the bbbb contract's ACME into the testnet-a/aaaa ACME group (a group never spans contracts).
    const r2 = await runVectors(
      normative,
      consumer((res) => {
        const groups = (res.groups ?? []) as Json[];
        const main = groups.find((g) => g.symbol_hex === '41434d45' && g.contractAddress === 'aa'.repeat(32) && g.network === 'testnet-a');
        const foreign = groups.find((g) => g.symbol_hex === '41434d45' && g.contractAddress === 'bb'.repeat(32));
        if (main !== undefined && foreign !== undefined) main.members = [...(main.members as Json[]), ...(foreign.members as Json[])];
        return res;
      }),
    );
    expect(failed(r2)).toEqual(['S9a', 'S9b', 'S9c', 'S9d']);
  });

  it('a consumer that does not display amounts passes S8 (and A4b-state), the display check not applicable', async () => {
    const r = await runVectors(
      normative,
      consumer((res) => {
        delete res.display;
        return res;
      }),
    );
    expect(failed(r)).toEqual([]);
    expect(Object.keys(r.notApplicable).sort()).toEqual(['A4b-state', 'S8']);
    expect(r.notApplicable.S8![0]).toMatch(/does not display amounts/);
  });

  it('a consumer that indexes only the common keys passes; one that drops `name` fails', async () => {
    const onlyCommon = await runVectors(
      normative,
      consumer((res) => {
        for (const id of res.identities as Json[])
          id.fields = Object.fromEntries(Object.entries(id.fields as Json).filter(([k]) => COMMON.has(k)));
        return res;
      }),
    );
    expect(failed(onlyCommon)).toEqual([]);
    const noted = onlyCommon.results.filter((x) => x.notes.length > 0).map((x) => x.id);
    expect(noted).toEqual(['A3a-state', 'A5a-state', 'A5b-state', 'A5c-state', 'S9a', 'S9b', 'S9c', 'S9d']);

    const noName = await runVectors(
      normative,
      consumer((res) => {
        for (const id of res.identities as Json[]) delete (id.fields as Json)['6e616d65'];
        return res;
      }),
    );
    expect(failed(noName).length).toBeGreaterThan(20);
    expect(noName.results.find((x) => x.id === 'S1a')!.failures.join()).toMatch(/field 6e616d65 \(name\) missing/);
  });

  it('a consumer that reports a key the expectation does not have still fails', async () => {
    const r = await runVectors(
      normative,
      consumer((res) => {
        const first = (res.identities as Json[])[0];
        if (first !== undefined) (first.fields as Json)['78'] = { valType: 0, value_hex: '' };
        return res;
      }),
    );
    expect(failed(r).length).toBe(normative.filter((v) => v.entry.kind === 'state').length);
  });
});
