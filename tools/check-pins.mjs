#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Official binaries only (Midnight releases and midnightntwrk images). Checks that:
//   1. every container image referenced in docker/, test-contracts/ and .github/
//      is pinned by digest, comes from `midnightntwrk/*` or the official `node`
//      image, and is listed in toolchain.json;
//   2. docker/Dockerfile's ARG pins (node image, Compact release and devtool,
//      versions and SHA-256s) equal toolchain.json, and its downloads come from
//      the official midnightntwrk/compact releases;
//   3. the npm pins in toolchain.json equal package.json overrides and the
//      workspace manifests that use them;
//   4. no file in those places mentions a non-official binary source;
//   5. the install (node_modules) holds exactly one copy of each single-copy
//      package (@midnightntwrk/ledger-v9, @midnightntwrk/onchain-runtime-v4), at
//      the pinned version, and the top-level copy of every other npm pin is the
//      pinned version. Two copies of the ledger WASM make contract calls fail.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot, toolchain } from './lib/mip.mjs';

const tc = toolchain();
const problems = [];
const fail = (msg) => problems.push(msg);

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (['node_modules', 'managed', '.state', '.git', '.cache', 'records'].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(sh|ya?ml|mjs|ts|json)$|Dockerfile$/u.test(e)) out.push(p);
  }
  return out;
};
const files = ['docker', 'test-contracts', '.github', 'tools'].flatMap((d) => walk(join(repoRoot, d)));

// 1. images
const allowed = new Set(
  Object.entries(tc.images)
    .filter(([k]) => !k.startsWith('$'))
    .map(([, v]) => v),
);
const imageRef = /\b((?:midnightntwrk|[a-z0-9-]+\/[a-z0-9-]+|node)(?::[\w.-]+)?@sha256:[0-9a-f]{64})/gu;
const anyMidnightImage = /\bmidnightntwrk\/[a-z0-9-]+(?::[\w.-]+)?(@sha256:[0-9a-f]{64})?/gu;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(repoRoot, f);
  for (const m of text.matchAll(imageRef)) {
    const ref = m[1];
    if (!ref.startsWith('midnightntwrk/') && !ref.startsWith('node:'))
      fail(`${rel}: ${ref} is not an official midnightntwrk/* or node image`);
    else if (!allowed.has(ref)) fail(`${rel}: ${ref} is not pinned in toolchain.json`);
  }
  for (const m of text.matchAll(anyMidnightImage)) {
    // An image reference with a tag must carry its digest (npm scopes like @midnightntwrk/x have no tag).
    if (text[m.index - 1] !== '@' && m[0].includes(':') && !m[1]) fail(`${rel}: image ${m[0]} is not pinned by digest`);
  }
  if (!rel.startsWith('tools/') && /\b(effectstream|acedward)\b/iu.test(text))
    fail(`${rel}: mentions a non-official source (effectstream/acedward)`);
}

// 2. Dockerfile
const dockerfile = readFileSync(join(repoRoot, 'docker', 'Dockerfile'), 'utf8');
const arg = (name) => new RegExp(`^ARG ${name}=(.+)$`, 'mu').exec(dockerfile)?.[1];
const expectArg = (name, want) => {
  if (arg(name) !== want) fail(`docker/Dockerfile ARG ${name}=${arg(name)} but toolchain.json says ${want}`);
};
expectArg('NODE_IMAGE', tc.images.node);
expectArg('COMPACT_VERSION', tc.compact.version);
expectArg('COMPACT_SHA256_X86_64', tc.compact.release.sha256['x86_64-unknown-linux-musl']);
expectArg('COMPACT_SHA256_AARCH64', tc.compact.release.sha256['aarch64-unknown-linux-musl']);
expectArg('COMPACT_DEVTOOL_VERSION', tc.compact.devtool.version);
expectArg('COMPACT_DEVTOOL_SHA256_X86_64', tc.compact.devtool.sha256['x86_64-unknown-linux-musl']);
expectArg('COMPACT_DEVTOOL_SHA256_AARCH64', tc.compact.devtool.sha256['aarch64-unknown-linux-musl']);
expectArg('COMPACT_RELEASES', 'https://github.com/midnightntwrk/compact/releases/download');
if (!tc.compact.release.urlTemplate.startsWith('https://github.com/midnightntwrk/compact/releases/download/'))
  fail('toolchain.json compact.release.urlTemplate is not an official midnightntwrk/compact release');

// 3. npm pins
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
for (const [name, version] of Object.entries(tc.npm)) {
  if (name.startsWith('$')) continue;
  if (!/^@(midnight-ntwrk|midnightntwrk|openzeppelin)\//u.test(name)) fail(`toolchain.json npm ${name} is not from an official scope`);
  const override = rootPkg.overrides?.[name];
  if (override !== undefined && override !== version) fail(`package.json overrides ${name}=${override}, toolchain.json says ${version}`);
}
const manifests = walk(join(repoRoot, 'packages'))
  .concat(walk(join(repoRoot, 'examples')), walk(join(repoRoot, 'test-contracts')))
  .filter((f) => f.endsWith('package.json'));
for (const f of manifests) {
  const pkg = JSON.parse(readFileSync(f, 'utf8'));
  for (const deps of [pkg.dependencies ?? {}, pkg.devDependencies ?? {}]) {
    for (const [name, version] of Object.entries(deps)) {
      const pinned = tc.npm[name];
      if (pinned !== undefined && pinned !== version) fail(`${relative(repoRoot, f)}: ${name}@${version}, toolchain.json says ${pinned}`);
    }
  }
}

// 5. install
const SINGLE_COPY = ['@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4'];
const nodeModules = join(repoRoot, 'node_modules');
/** Every installed copy of a package: [path relative to the repository, version]. */
const installedCopies = (name) => {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      if (e.startsWith('@')) {
        for (const s of readdirSync(join(dir, e))) visitPackage(join(dir, e, s), `${e}/${s}`);
      } else visitPackage(join(dir, e), e);
    }
  };
  const visitPackage = (pkgDir, pkgName) => {
    const manifest = join(pkgDir, 'package.json');
    if (pkgName === name && existsSync(manifest))
      out.push([relative(repoRoot, pkgDir), JSON.parse(readFileSync(manifest, 'utf8')).version]);
    visit(join(pkgDir, 'node_modules'));
  };
  visit(nodeModules);
  return out;
};
let installChecked = 0;
if (!existsSync(nodeModules)) fail('node_modules is missing: install first (docker/run.sh ci), then run check:pins');
else {
  for (const name of SINGLE_COPY) {
    const want = tc.npm[name];
    if (want === undefined) fail(`toolchain.json npm has no pin for ${name}`);
    const copies = installedCopies(name);
    if (copies.length !== 1)
      fail(
        `${name}: ${copies.length} installed copies (${copies.map(([p, v]) => `${p}@${v}`).join(', ') || 'none'}), exactly one required`,
      );
    else if (copies[0][1] !== want) fail(`${name}: installed ${copies[0][1]}, toolchain.json says ${want}`);
    else installChecked++;
  }
  for (const [name, want] of Object.entries(tc.npm)) {
    if (name.startsWith('$') || SINGLE_COPY.includes(name)) continue;
    const manifest = join(nodeModules, name, 'package.json');
    if (!existsSync(manifest)) fail(`${name} is not installed at the top level of node_modules`);
    else {
      const have = JSON.parse(readFileSync(manifest, 'utf8')).version;
      if (have !== want) fail(`node_modules/${name}@${have}, toolchain.json says ${want}`);
      else installChecked++;
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(
  `OK ${allowed.size} images, Compact ${tc.compact.version} release + devtool ${tc.compact.devtool.version}, ${Object.keys(tc.npm).filter((k) => !k.startsWith('$')).length} npm pins (${installChecked} installed as pinned; one copy each of ${SINGLE_COPY.join(', ')}); official sources only`,
);
