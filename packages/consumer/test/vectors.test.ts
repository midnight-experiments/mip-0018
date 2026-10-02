// SC-001 / FR-014: the reference consumer passes 100 % of the normative vectors (and all informative ones), both
// in-process and through the language-neutral runner CLI with bin/vector-adapter.js; every response it produces is
// valid under the runner protocol schema.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VECTORS_DIR } from '@mip0018/vectors/common';
import { formatReport, loadVectors, requestFor, runVectors } from '@mip0018/vectors/runner';
import { makeAjv } from '@mip0018/vectors/validate';
import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/adapter.ts';

const ADAPTER = fileURLToPath(new URL('../bin/vector-adapter.js', import.meta.url));
const vectors = loadVectors();

describe('reference consumer against the vectors', () => {
  it('passes every normative (67) and informative (34) vector in-process', async () => {
    const report = await runVectors(vectors, async (req) => handleRequest(req));
    const failed = report.results.filter((r) => !r.ok);
    if (failed.length > 0) console.log(formatReport(report));
    expect(report.normative).toEqual({ passed: 67, total: 67 });
    expect(report.informative).toEqual({ passed: 34, total: 34 });
    expect(report.results.flatMap((r) => r.notes)).toEqual([]); // reason codes and offsets match too
  });

  it('every response is valid under runner.schema.json#/$defs/response', () => {
    const validate = makeAjv().getSchema(
      'https://github.com/midnight-experiments/mip-0018/vectors/schema/runner.schema.json#/$defs/response',
    )!;
    for (const v of vectors) {
      const res = handleRequest(requestFor(v));
      expect(validate(res), `${v.entry.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('the runner CLI with bin/vector-adapter.js reports 67/67 and exits 0', () => {
    const r = spawnSync(process.execPath, [join(VECTORS_DIR, 'tools/run.ts'), '--notes', '--consumer', `${process.execPath} ${ADAPTER}`], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/normative: 67\/67 passed; informative: 34\/34 passed/);
    expect(r.stdout).not.toMatch(/^FAIL/m);
    expect(r.stdout).not.toMatch(/note:/);
    expect(r.status).toBe(0);
  });

  it('the adapter answers malformed requests with an error line instead of crashing', () => {
    const r = spawnSync(process.execPath, [ADAPTER], {
      input: 'not json\n{"id":"x","op":"nope"}\n{"id":"y","op":"decode","type":"Misc","name_hex":"00","payload_hex":""}\n',
      encoding: 'utf8',
    });
    const lines = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: null });
    expect(lines[1]).toMatchObject({ id: 'x' });
    expect(lines[2]).toMatchObject({ id: 'y' });
    for (const l of lines) expect(typeof l.error).toBe('string');
    expect(r.status).toBe(0);
  });
});
