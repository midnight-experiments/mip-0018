#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Official binaries only (Midnight releases and midnightntwrk images). Checks, over every file of the repository
// (node_modules, compiler output, local state and caches excluded):
//   1. images: every image a file of these kinds names is pinned by digest and listed in toolchain.json:
//      - compose files. Every .yml / .yaml file is parsed as YAML (a file that does not parse fails the check); a
//        document whose top-level mapping has a `services` key is a compose file, in any YAML notation (block or flow
//        style, quoted keys, anchors and merge keys). A .json file is a compose file (Compose reads it as YAML) when it
//        is named as one (`compose.json`, `docker-compose.json`, `compose.<name>.json`, …) and has a top-level
//        `services` key, or when its top-level `services` is a mapping with a service that has an `image`; a
//        compose-named .json file that neither JSON nor YAML can read fails the check. Each service's `image` counts
//        (`${VAR:-default}` defaults resolved);
//      - Dockerfiles: each `FROM` (ARG and `${VAR:-default}` defaults resolved; `scratch` and the file's own build
//        stages excepted);
//      - GitHub Actions workflows (.github/workflows/*.yml / *.yaml): each job's `container` (an image, or a mapping
//        with `image`), each `services.<name>.image` of a job, and each step's `uses: docker://<image>`; an image
//        written as a `${{ … }}` expression fails the check (its value is not in the file).
//      A services / service / job / container that is not a mapping, or an image that is not a string, fails the check:
//      an image the check cannot read is not accepted. In every .sh/.yml/.yaml/.mjs/.ts/.json file and Dockerfile, each
//      digest-pinned reference comes from `midnightntwrk/*` or the official `node` image and is listed in
//      toolchain.json, and each tagged `midnightntwrk/<name>:<tag>` carries its digest. An untagged
//      `midnightntwrk/<name>` outside the files above is a repository or product name (prose, a GitHub path), not an
//      image reference, and is not checked;
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
const isJson = (f) => /\.json$/u.test(f);
/** A JSON file named as a compose file: compose.json, docker-compose.json, compose.override.json, … */
const isComposeJsonName = (f) => /^(?:docker-)?compose(?:\.[\w-]+)*\.json$/u.test(basename(f));
/** A GitHub Actions workflow file (repository-relative path). */
const isWorkflow = (rel) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(rel.split('\\').join('/'));
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
 * The YAML documents of a text (JSON is YAML too): `docs` = [{ js, at }] with `js` the document's value (merge keys
 * resolved) and `at(path)` the line of the node at a key path (or of its nearest ancestor that is in the text), and
 * `problems` = [line, why] for each document that does not parse.
 */
const yamlDocuments = (text) => {
  const lc = new LineCounter();
  const docs = [];
  const problems = [];
  const parsed = parseAllDocuments(text, { lineCounter: lc, merge: true });
  for (const doc of Array.isArray(parsed) ? parsed : []) {
    if (doc.errors.length > 0) {
      problems.push([lc.linePos(doc.errors[0].pos[0]).line, `cannot be read as YAML (${doc.errors[0].message.split('\n')[0]})`]);
      continue;
    }
    try {
      const at = (path) => {
        for (let n = path.length; n > 0; n--) {
          const node = doc.getIn(path.slice(0, n), true);
          if (node?.range) return lc.linePos(node.range[0]).line;
        }
        return 1;
      };
      docs.push({ js: doc.toJS({ maxAliasCount: 1000 }), at });
    } catch (e) {
      problems.push([1, `cannot be read as YAML (${e.message.split('\n')[0]})`]);
    }
  }
  return { docs, problems };
};

/**
 * The documents of a .json file: its JSON value (line numbers from the YAML reading of the same text, when it has
 * one); a text that is not JSON is read as YAML, as Compose reads it.
 */
const jsonDocuments = (text) => {
  let js;
  try {
    js = JSON.parse(text);
  } catch {
    return yamlDocuments(text);
  }
  let lines;
  const at = (path) => {
    lines ??= yamlDocuments(text);
    return lines.docs.length === 1 ? lines.docs[0].at(path) : 1;
  };
  return { docs: [{ js, at }], problems: [] };
};

const hasImage = (svc) => isMapping(svc) && Object.hasOwn(svc, 'image');

/** The images of a compose document's services into `out` ([line, as written, resolved]); unreadable ones into `problems`. */
const composeImages = ({ js, at }, out, problems) => {
  if (!isMapping(js.services)) {
    problems.push([at(['services']), 'services is not a mapping']);
    return;
  }
  for (const [name, svc] of Object.entries(js.services)) {
    const where = at(['services', name, 'image']);
    if (!isMapping(svc)) {
      problems.push([where, `service ${name} is not a mapping`]);
      continue;
    }
    if (!Object.hasOwn(svc, 'image')) continue;
    if (typeof svc.image !== 'string') {
      problems.push([where, `service ${name}: image is not a string`]);
      continue;
    }
    out.push([where, svc.image, resolveVars(svc.image, {})]);
  }
};

/** A workflow image: its value, or undefined when it is a `${{ … }}` expression (its value is not in the file). */
const workflowImage = (ref) => (ref.includes('${{') ? undefined : ref);

/** The images of a GitHub Actions workflow document: job containers, job services and `docker://` steps. */
const workflowImages = ({ js, at }, out, problems) => {
  if (!isMapping(js) || !Object.hasOwn(js, 'jobs')) return;
  if (!isMapping(js.jobs)) {
    problems.push([at(['jobs']), 'jobs is not a mapping']);
    return;
  }
  for (const [id, job] of Object.entries(js.jobs)) {
    if (!isMapping(job)) {
      problems.push([at(['jobs', id]), `job ${id} is not a mapping`]);
      continue;
    }
    if (Object.hasOwn(job, 'container')) {
      const c = job.container;
      const image = isMapping(c) ? c.image : c;
      const where = at(isMapping(c) ? ['jobs', id, 'container', 'image'] : ['jobs', id, 'container']);
      if (typeof image === 'string') out.push([where, image, workflowImage(image)]);
      else problems.push([where, `job ${id}: container image is not a string`]);
    }
    if (Object.hasOwn(job, 'services')) {
      if (!isMapping(job.services)) problems.push([at(['jobs', id, 'services']), `job ${id}: services is not a mapping`]);
      else
        for (const [name, svc] of Object.entries(job.services)) {
          const where = at(['jobs', id, 'services', name, 'image']);
          if (isMapping(svc) && typeof svc.image === 'string') out.push([where, svc.image, workflowImage(svc.image)]);
          else problems.push([where, `job ${id}: service ${name} image is not a string`]);
        }
    }
    for (const [i, step] of (Array.isArray(job.steps) ? job.steps : []).entries()) {
      if (isMapping(step) && typeof step.uses === 'string' && step.uses.startsWith('docker://')) {
        const image = step.uses.slice('docker://'.length);
        out.push([at(['jobs', id, 'steps', i, 'uses']), image, workflowImage(image)]);
      }
    }
  }
};

/**
 * The images of a compose file (YAML, or JSON as the header says) or a workflow: { images: [line, as written, resolved
 * or undefined], problems: [line, why] }; undefined for a file of another kind.
 */
const fileImages = (rel, text) => {
  const json = isJson(rel);
  if (!json && !isYaml(rel)) return undefined;
  const composeNamed = json && isComposeJsonName(rel);
  if (json && !composeNamed) {
    // fast path: a JSON value without a top-level services key is not a compose file
    try {
      const v = JSON.parse(text);
      if (!isMapping(v) || !Object.hasOwn(v, 'services')) return undefined;
    } catch {
      // not JSON: read below as YAML
    }
  }
  const { docs, problems } = json ? jsonDocuments(text) : yamlDocuments(text);
  const images = [];
  const found = { images, problems: json && !composeNamed ? [] : problems };
  for (const doc of docs) {
    const services = isMapping(doc.js) && Object.hasOwn(doc.js, 'services');
    const compose =
      !json || composeNamed ? services : services && isMapping(doc.js.services) && Object.values(doc.js.services).some(hasImage);
    if (compose) composeImages(doc, images, found.problems);
    if (isWorkflow(rel)) workflowImages(doc, images, found.problems);
  }
  return found;
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
  const found = isDockerfile(f) ? { images: dockerfileImages(text), problems: [] } : fileImages(rel, text);
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
  `OK ${allowed.size} images (${imageRefs} references in compose files, Dockerfiles and workflows, each pinned by digest), Compact ${tc.compact.version} release + devtool ${tc.compact.devtool.version}, ${Object.keys(tc.npm).filter((k) => !k.startsWith('$')).length} npm pins (${installChecked} installed as pinned; one copy each of ${SINGLE_COPY.join(', ')}); official sources only`,
);
