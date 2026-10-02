// SPDX-License-Identifier: Apache-2.0
//
// Keeps the "add these lines" blocks of the OpenZeppelin example READMEs equal to the sources.
//
// Two kinds of checked block, each announced by an HTML comment on the line before its fence:
//
//   <!-- readme-diff from="contracts/without-metadata/X.compact" to="contracts/X.compact" -->
//   ```diff
//   (the unified diff from -> to, 2 lines of context, computed here)
//   ```
//
//   <!-- readme-snippet file="fungible-token/contracts/X.compact" -->
//   ```compact
//   (lines that must appear in the file, in order and contiguous; a line `// ...` skips any lines)
//   ```
//
// Paths are relative to the README. `checkReadme` reports every block that differs; `fix: true`
// rewrites diff blocks in place (snippets are never rewritten: they are prose excerpts).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CONTEXT = 2;

type Op = { tag: ' ' | '-' | '+'; text: string; a: number; b: number };

/** Line diff (longest common subsequence), as a list of keep / remove / add operations. */
export const diffLines = (a: readonly string[], b: readonly string[]): Op[] => {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ tag: ' ', text: a[i]!, a: i++, b: j++ });
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ tag: '-', text: a[i]!, a: i++, b: j });
    else ops.push({ tag: '+', text: b[j]!, a: i, b: j++ });
  }
  return ops;
};

/** Unified diff hunks (`@@ -a,b +c,d @@`) with `context` lines around each change. */
export const unifiedDiff = (a: readonly string[], b: readonly string[], context = CONTEXT): string => {
  const ops = diffLines(a, b);
  const changed = ops.map((o, k) => (o.tag === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    const last = hunks.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const out: string[] = [];
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const aLen = slice.filter((o) => o.tag !== '+').length;
    const bLen = slice.filter((o) => o.tag !== '-').length;
    out.push(`@@ -${slice[0]!.a + 1},${aLen} +${slice[0]!.b + 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.tag}${o.text}`.trimEnd());
  }
  return out.join('\n');
};

const lines = (path: string): string[] => readFileSync(path, 'utf8').replace(/\n$/u, '').split('\n');

type Block = { kind: 'diff' | 'snippet'; attrs: Record<string, string>; start: number; end: number; body: string[] };

/** The checked blocks of a README: the marker comment, then a fenced block (start/end = fence lines). */
const blocks = (text: string[]): Block[] => {
  const out: Block[] = [];
  for (let i = 0; i < text.length; i++) {
    const m = /^<!-- readme-(diff|snippet)((?:\s+\w+="[^"]*")+)\s*-->$/u.exec(text[i]!.trim());
    if (!m) continue;
    const attrs = Object.fromEntries([...m[2]!.matchAll(/(\w+)="([^"]*)"/gu)].map((x) => [x[1]!, x[2]!]));
    const start = i + 1;
    if (!/^```/u.test(text[start] ?? '')) throw new Error(`line ${i + 1}: readme-${m[1]} marker not followed by a fenced block`);
    let end = start + 1;
    while (end < text.length && !/^```\s*$/u.test(text[end]!)) end++;
    if (end >= text.length) throw new Error(`line ${start + 1}: unterminated fenced block`);
    out.push({ kind: m[1] as Block['kind'], attrs, start, end, body: text.slice(start + 1, end) });
    i = end;
  }
  return out;
};

/** True if `needle` (with `// ...` gap lines) occurs in `hay` in order, each run contiguous. */
const containsSnippet = (hay: readonly string[], needle: readonly string[]): boolean => {
  const runs: string[][] = [[]];
  for (const l of needle) {
    if (l.trim() === '// ...') runs.push([]);
    else runs.at(-1)!.push(l.trimEnd());
  }
  const h = hay.map((l) => l.trimEnd());
  let from = 0;
  for (const run of runs.filter((r) => r.length > 0)) {
    let found = -1;
    for (let k = from; k + run.length <= h.length && found < 0; k++) if (run.every((l, d) => h[k + d] === l)) found = k;
    if (found < 0) return false;
    from = found + run.length;
  }
  return true;
};

export type ReadmeProblem = { readme: string; line: number; message: string };

/** Checks (and with `fix`, rewrites the diff blocks of) one README. Returns the problems found. */
export const checkReadme = (readme: string, o: { fix?: boolean } = {}): { problems: ReadmeProblem[]; blocks: number } => {
  const text = lines(readme);
  const base = dirname(readme);
  const problems: ReadmeProblem[] = [];
  const found = blocks(text);
  for (const b of [...found].reverse()) {
    if (b.kind === 'diff') {
      if (!b.attrs.from || !b.attrs.to) throw new Error(`${readme}:${b.start}: readme-diff needs from="…" and to="…"`);
      const want = unifiedDiff(lines(join(base, b.attrs.from)), lines(join(base, b.attrs.to))).split('\n');
      if (want.join('\n') !== b.body.join('\n')) {
        if (o.fix) text.splice(b.start + 1, b.end - b.start - 1, ...want);
        else
          problems.push({
            readme,
            line: b.start + 1,
            message: `diff ${b.attrs.from} → ${b.attrs.to} differs from the sources (run with --fix)`,
          });
      }
    } else {
      if (!b.attrs.file) throw new Error(`${readme}:${b.start}: readme-snippet needs file="…"`);
      if (!containsSnippet(lines(join(base, b.attrs.file)), b.body))
        problems.push({
          readme,
          line: b.start + 1,
          message: `snippet is not in ${b.attrs.file} (in order, contiguous between "// ..." lines)`,
        });
    }
  }
  if (o.fix) writeFileSync(readme, `${text.join('\n')}\n`);
  return { problems, blocks: found.length };
};
