// The language-neutral runner CLI: spawns a consumer, exits non-zero on normative failures, reports every test id.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VECTORS_DIR } from '../tools/common.ts';

const RUN = join(VECTORS_DIR, 'tools/run.ts');
const dir = mkdtempSync(join(tmpdir(), 'mip0018-runner-'));

function consumerScript(body: string): string {
  const file = join(dir, `c${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `import { createInterface } from 'node:readline';\nconst rl = createInterface({ input: process.stdin });\nrl.on('line', (line) => { const req = JSON.parse(line); ${body} });\n`,
  );
  return `${process.execPath} ${file}`;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 60_000 });
}

describe('runner CLI', () => {
  it('a consumer that ignores everything fails normative vectors and exits 1, listing every MIP test id', () => {
    const r = run([
      '--consumer',
      consumerScript(
        `console.log(JSON.stringify(req.op === 'decode' ? { id: req.id, result: 'ignore' } : { id: req.id, identities: [] }));`,
      ),
    ]);
    expect(r.status).toBe(1);
    for (const t of [
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'IGNORE',
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
      'S8',
      'S9',
    ]) {
      expect(r.stdout).toMatch(new RegExp(`^  ${t} `, 'm'));
    }
    expect(r.stdout).toMatch(/^PASS +I1a /m); // ignore vectors pass
    expect(r.stdout).toMatch(/^FAIL +A1 /m);
    expect(r.stdout).toMatch(/normative: 5\/67 passed/);
  });

  it('--only selects vectors by id or MIP test id', () => {
    const r = run(['--only', 'IGNORE', '--consumer', consumerScript(`console.log(JSON.stringify({ id: req.id, result: 'ignore' }));`)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/normative: 5\/5 passed/);
  });

  it('a consumer that exits early fails the remaining vectors', () => {
    const r = run(['--only', 'IGNORE', '--consumer', consumerScript(`process.exit(3);`)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/consumer exited/);
  });

  it('an invalid JSON line is a failure of that vector', () => {
    const r = run(['--only', 'I1a', '--consumer', consumerScript(`console.log('not json');`)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/invalid JSON response/);
  });

  it('a mismatched response id is a failure', () => {
    const r = run(['--only', 'I1a', '--consumer', consumerScript(`console.log(JSON.stringify({ id: 'other', result: 'ignore' }));`)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/does not match request id/);
  });

  it('resolves a relative consumer command against INIT_CWD (npm runs workspace scripts in the workspace folder)', () => {
    const abs = consumerScript(`console.log(JSON.stringify({ id: req.id, result: 'ignore' }));`).split(' ')[1]!;
    const rel = abs.slice(dir.length + 1);
    const r = spawnSync(process.execPath, [RUN, '--only', 'IGNORE', '--consumer', `${process.execPath} ./${rel}`], {
      encoding: 'utf8',
      cwd: VECTORS_DIR,
      env: { ...process.env, INIT_CWD: dir },
    });
    expect(r.stdout).toMatch(/normative: 5\/5 passed/);
    expect(r.status).toBe(0);
  });

  it('usage errors exit 2', () => {
    expect(run([]).status).toBe(2);
  });
});
