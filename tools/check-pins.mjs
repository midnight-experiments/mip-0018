#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Official binaries only (Midnight releases and midnightntwrk images). Checks, over every file of the repository
// (node_modules, compiler output, local state and caches excluded):
//   1. images: every .yml / .yaml file is parsed as YAML (a file that does not parse fails the check); a document whose
//      top-level mapping has a `services` key is a compose file, in any YAML notation (block or flow style, quoted
//      keys, anchors and merge keys). Each service's `image` in a compose file and each `FROM` of a Dockerfile (ARG and
//      `${VAR:-default}` defaults resolved; `scratch` and the file's own build stages excepted) is pinned by digest and listed in
//      toolchain.json; in every .sh/.yml/.yaml/.mjs/.ts/.json file and Dockerfile, each digest-pinned reference comes from
//      `midnightntwrk/*` or the official `node` image and is listed in toolchain.json, and each tagged
//      `midnightntwrk/<name>:<tag>` carries its digest. An untagged `midnightntwrk/<name>` outside a compose file or
//      Dockerfile is a repository or product name (prose, a GitHub path), not an image reference, and is not checked;
//   2. docker/Dockerfile's ARG pins (node image, Compact release and devtool,
//      versions and SHA-256s) equal toolchain.json, and its downloads come from
//      the official midnightntwrk/compact releases;
//   3. the npm pins in toolchain.json equal package.json overrides and the
//      workspace manifests that use them;
//   4. no file outside tools/ mentions a non-official binary source;
//   5. the install (node_modules) holds exactly one copy of each single-copy
//      package (@midnightntwrk/ledger-v9, @midnightntwrk/onchain-runtime-v4), at
//      the pinned version, and the top-level copy of every other npm pin is the
//      pinned version (nested copies that dependencies bring are not checked). Two copies of the ledger WASM make
//      contract calls fail.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { LineCounter, parseAllDocuments } from 'yaml';
import { repoRoot, toolchain } from './lib/mip.mjs';

const tc = toolchain();
const problems = [];
const fail = (msg) => problems.push(msg);

const isDockerfile = (f) => /^(Dockerfile|Containerfile)(\..+)?$|\.(Dockerfile|Containerfile)$/u.test(basename(f));

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
    else if (/\.(sh|ya?ml|mjs|ts|json)$/u.test(e) || isDockerfile(e)) out.push(p);
  }
  return out;
};
const files = walk(repoRoot);

const isYaml = (f) => /\.ya?ml$/u.test(f);
const DIGEST = /@sha256:[0-9a-f]{64}$/u;

/** `${VAR:-default}` / `${VAR-default}` / `${VAR}` / `$VAR` resolved from `vars`; undefined when a variable has no value. */
const resolveVars = (ref, vars) => {
  let unresolved = false;
  const out = ref.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/gu, (_m, a, def, b) => {
    const v = vars[a ?? b] ?? def;
    if (v === undefined) unresolved = true;
    return v ?? '';
  });
  return unresolved ? undefined : out;
};

/** Every image a Dockerfile references: [line, reference as written, resolved reference or undefined]. */
const dockerfileImages = (text) => {
  const out = [];
  const args = {};
  const stages = new Set();
  text.split('\n').forEach((line, i) => {
    const a = /^\s*ARG\s+(\w+)=(\S+)/u.exec(line);
    if (a) args[a[1]] = a[2].replace(/^["']|["']$/gu, '');
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
    if (!m) return;
    if (m[1] !== 'scratch' && !stages.has(m[1].toLowerCase())) out.push([i + 1, m[1], resolveVars(m[1], args)]);
    if (m[2]) stages.add(m[2].toLowerCase());
  });
  return out;
};

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The images of a YAML file's compose documents: [line, reference as written, resolved reference or undefined], or a
 * problem. The documents are parsed (any notation; merge keys resolved); a document is a compose file when its
 * top-level mapping has a `services` key. A file that does not parse, or a compose document whose `services` or a
 * service is not a mapping or whose `image` is not a string, is a problem: an image the check cannot read is not
 * accepted.
 */
const composeImages = (text) => {
  const out = [];
  const problems = [];
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, merge: true });
  const lineOf = (node) => (node?.range ? lc.linePos(node.range[0]).line : 1);
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (doc.errors.length > 0) {
      problems.push([lineOf({ range: doc.errors[0].pos }), `cannot be read as YAML (${doc.errors[0].message.split('\n')[0]})`]);
      continue;
    }
    let js;
    try {
      js = doc.toJS({ maxAliasCount: 1000 });
    } catch (e) {
      problems.push([1, `cannot be read as YAML (${e.message.split('\n')[0]})`]);
      continue;
    }
    if (!isMapping(js) || !Object.hasOwn(js, 'services')) continue;
    if (!isMapping(js.services)) {
      problems.push([lineOf(doc.get('services', true)), 'services is not a mapping']);
      continue;
    }
    for (const [name, svc] of Object.entries(js.services)) {
      const at = lineOf(doc.getIn(['services', name, 'image'], true) ?? doc.getIn(['services', name], true));
      if (!isMapping(svc)) {
        problems.push([at, `service ${name} is not a mapping`]);
        continue;
      }
      if (!Object.hasOwn(svc, 'image')) continue;
      if (typeof svc.image !== 'string') {
        problems.push([at, `service ${name}: image is not a string`]);
        continue;
      }
      out.push([at, svc.image, resolveVars(svc.image, {})]);
    }
  }
  return { images: out, problems };
};

// 1. images
const allowed = new Set(
  Object.entries(tc.images)
    .filter(([k]) => !k.startsWith('$'))
    .map(([, v]) => v),
);
const imageRef = /\b((?:midnightntwrk|[a-z0-9-]+\/[a-z0-9-]+|node)(?::[\w.-]+)?@sha256:[0-9a-f]{64})/gu;
const anyMidnightImage = /\bmidnightntwrk\/[a-z0-9-]+(?::[\w.-]+)?(@sha256:[0-9a-f]{64})?/gu;
let imageRefs = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(repoRoot, f);
  const found = isDockerfile(f) ? { images: dockerfileImages(text), problems: [] } : isYaml(f) ? composeImages(text) : undefined;
  for (const [line, why] of found?.problems ?? []) fail(`${rel}:${line}: ${why}`);
  if (found)
    for (const [line, written, ref] of found.images) {
      imageRefs++;
      if (ref === undefined) fail(`${rel}:${line}: image ${written} has a variable without a pinned default`);
      else if (!DIGEST.test(ref)) fail(`${rel}:${line}: image ${ref} is not pinned by digest`);
      else if (!allowed.has(ref)) fail(`${rel}:${line}: image ${ref} is not pinned in toolchain.json`);
    }
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
  `OK ${allowed.size} images (${imageRefs} references in compose files and Dockerfiles, each pinned by digest), Compact ${tc.compact.version} release + devtool ${tc.compact.devtool.version}, ${Object.keys(tc.npm).filter((k) => !k.startsWith('$')).length} npm pins (${installChecked} installed as pinned; one copy each of ${SINGLE_COPY.join(', ')}); official sources only`,
);
