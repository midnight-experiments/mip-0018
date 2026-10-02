#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Checks every relative link in the repository's Markdown files: the target file or directory exists and, for a
// link into a Markdown file, the #anchor is one of its headings (GitHub slugs) or an explicit <a id/name>.
// External links (any URL scheme) are not fetched. Links inside code blocks and inline code are not links.
//
//   node tools/check-md-links.mjs            # check; exit 1 on any broken link
//   node tools/check-md-links.mjs --list     # also print every checked link
//
// Files: `git ls-files '*.md'`; where git cannot read the repository (e.g. a worktree mounted into a container
// without its main .git), every *.md under the repository except ignored build/dependency folders.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'managed', '.git', '.cache', 'dist', 'coverage', '.state']);

function markdownFiles() {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '*.md'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.toString().split('\0').filter(Boolean);
    if (files.length > 0) return { source: 'git ls-files', files };
  } catch {
    // fall through to the walk
  }
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel);
      } else if (e.isFile() && e.name.endsWith('.md')) files.push(rel);
    }
  };
  walk('');
  return { source: 'directory walk', files: files.sort() };
}

/** The lines with fenced code blocks blanked (line numbers kept). */
function outsideFences(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) {
      fence = m[1];
      return '';
    }
    return line;
  });
}

/** As outsideFences, with inline code spans blanked too (code is never a link). */
const proseLines = (text) => outsideFences(text).map((line) => line.replace(/(`+)(?:(?!\1).)+?\1/gu, (s) => ' '.repeat(s.length)));

/** GitHub's heading anchor: lower case, punctuation and symbols dropped, spaces to hyphens. */
function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1') // links and images → their text
    .replace(/<[^>]+>/gu, '') // inline HTML
    .replace(/[`*~]/gu, '')
    .replace(/\\(.)/gu, '$1');
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /gu, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const anchors = new Set();
  const seen = new Map();
  const raw = readFileSync(file, 'utf8');
  for (const line of outsideFences(raw)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  for (const m of raw.matchAll(/<a\s+(?:id|name)="([^"]+)"/gu)) anchors.add(m[1]);
  anchorCache.set(file, anchors);
  return anchors;
}

/** Every link target in a Markdown text: inline links/images and reference definitions, with line numbers. */
function linksOf(text) {
  const out = [];
  proseLines(text).forEach((line, i) => {
    const def = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/u.exec(line);
    if (def) out.push({ line: i + 1, target: def[1].replace(/^<|>$/gu, '') });
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/gu)) {
      out.push({ line: i + 1, target: m[1].replace(/^<|>$/gu, '') });
    }
  });
  return out;
}

const list = process.argv.includes('--list');
const { source, files } = markdownFiles();
const problems = [];
let checked = 0;
for (const rel of files) {
  const file = join(repoRoot, rel);
  if (!existsSync(file)) continue;
  for (const { line, target } of linksOf(readFileSync(file, 'utf8'))) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue; // http:, https:, mailto: … — not checked here
    checked++;
    const hash = target.indexOf('#');
    const pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
    const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
    const dest = pathPart === '' ? file : resolve(dirname(file), pathPart);
    const where = `${rel}:${line}`;
    if (list) console.log(`${where} ${target}`);
    if (relative(repoRoot, dest).split(sep)[0] === '..') {
      problems.push(`${where} ${target}: points outside the repository`);
      continue;
    }
    if (!existsSync(dest)) {
      problems.push(`${where} ${target}: ${relative(repoRoot, dest)} does not exist`);
      continue;
    }
    if (anchor !== undefined && anchor !== '' && statSync(dest).isFile() && dest.endsWith('.md') && !anchorsOf(dest).has(anchor)) {
      problems.push(`${where} ${target}: no heading or anchor "#${anchor}" in ${relative(repoRoot, dest)}`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(`${problems.length} broken link(s) among ${checked} relative links in ${files.length} Markdown files (${source})`);
  process.exit(1);
}
console.log(`OK ${checked} relative links in ${files.length} Markdown files resolve (${source})`);
