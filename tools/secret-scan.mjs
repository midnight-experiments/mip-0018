#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Secret scan of the repository (SC-008): every tracked file, and with
// --history every blob reachable from any ref. Never prints a match, only where
// it is and which detector fired.
//
//   node tools/secret-scan.mjs              # tracked files
//   node tools/secret-scan.mjs --history    # plus every blob in the history
//   node tools/secret-scan.mjs --self-test  # positive control: planted secrets must be found
//
// Detectors: a run of >= 12 BIP-39 English words (a mnemonic); a 64-hex value
// labelled seed/secret/private/mnemonic/signing key; a {tag:"schnorr"|"ecdsa", value}
// signing key object; PEM private keys; secret-looking file names.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repoRoot } from './lib/mip.mjs';

const require = createRequire(import.meta.url);
const loadWordlist = async () => {
  const url = require.resolve('@scure/bip39/wordlists/english.js');
  return new Set((await import(url)).wordlist);
};

export const detect = (text, words) => {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let run = 0;
    for (const t of line.toLowerCase().split(/[^a-z]+/u)) {
      if (!t) continue;
      run = words.has(t) ? run + 1 : 0;
      if (run >= 12) {
        hits.push({ line: i + 1, detector: 'bip39-run' });
        break;
      }
    }
    // The dev chain's genesis seed (0x00..01) is public and allowed.
    if (/(seed|secret|private|mnemonic|signing.?key)[^\n]{0,40}?\b(?!0{63}1\b)[0-9a-f]{64}\b/iu.test(line))
      hits.push({ line: i + 1, detector: 'labelled-64-hex' });
    if (/"?tag"?\s*:\s*["'](schnorr|ecdsa)["'][^\n]{0,20}"?value"?\s*:\s*["'][0-9a-f]{32,}/iu.test(line))
      hits.push({ line: i + 1, detector: 'signing-key-object' });
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line)) hits.push({ line: i + 1, detector: 'pem-private-key' });
  });
  return hits;
};

const badName = (path) => /\.(mnemonic|seed|secret)$|private-state\.json$|wallet(-\d+)?\.cache$/iu.test(path);

const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 1 << 30 });

const words = await loadWordlist();

if (process.argv.includes('--self-test')) {
  const pick = [...words];
  const fakeMnemonic = Array.from({ length: 24 }, (_, i) => pick[(i * 97 + 13) % pick.length]).join(' ');
  const cases = [
    [`phrase: ${fakeMnemonic}`, 'bip39-run'],
    [`seed = ${'ab'.repeat(32)}`, 'labelled-64-hex'],
    [`{"tag":"schnorr","value":"${'cd'.repeat(32)}"}`, 'signing-key-object'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'pem-private-key'],
  ];
  let ok = true;
  for (const [text, want] of cases) {
    const found = detect(text, words).some((h) => h.detector === want);
    console.log(`${found ? 'OK  ' : 'FAIL'} planted ${want} is detected`);
    ok &&= found;
  }
  const clean = detect('The transaction hash 0123abcd and sha256 ' + 'ef'.repeat(32) + ' are public.', words);
  console.log(`${clean.length === 0 ? 'OK  ' : 'FAIL'} a plain hash is not flagged`);
  ok &&= clean.length === 0;
  const named =
    badName('x/stagenet-wallet.mnemonic') && badName('cache/s0-spike-private-state.json') && !badName('src/lib/private-state.ts');
  const devSeed = detect(`const GENESIS_DEV_SEED = Buffer.from('${'0'.repeat(63)}1', 'hex');`, words).length === 0;
  console.log(`${devSeed ? 'OK  ' : 'FAIL'} the public dev genesis seed is allowed`);
  ok &&= devSeed;
  console.log(`${named ? 'OK  ' : 'FAIL'} secret-looking file names are flagged`);
  process.exit(ok && named ? 0 : 1);
}

const findings = [];
const files = git('ls-files', '-z').toString().split('\0').filter(Boolean);
for (const f of files) {
  if (badName(f)) findings.push({ where: f, detector: 'file-name' });
  let text;
  try {
    text = readFileSync(join(repoRoot, f), 'utf8');
  } catch {
    continue;
  }
  if (f === 'tools/secret-scan.mjs') continue; // contains the detector patterns themselves
  for (const h of detect(text, words)) findings.push({ where: `${f}:${h.line}`, detector: h.detector });
}

let blobs = 0;
if (process.argv.includes('--history')) {
  const objects = git('rev-list', '--all', '--objects').toString().split('\n').filter(Boolean);
  const paths = new Map();
  for (const o of objects) {
    const [sha, ...rest] = o.split(' ');
    if (rest.length) paths.set(sha, rest.join(' '));
  }
  for (const [sha, path] of paths) {
    if (git('cat-file', '-t', sha).toString().trim() !== 'blob') continue;
    blobs++;
    if (badName(path)) findings.push({ where: `history:${sha.slice(0, 10)}:${path}`, detector: 'file-name' });
    if (path === 'tools/secret-scan.mjs') continue;
    const text = git('cat-file', '-p', sha).toString('utf8');
    for (const h of detect(text, words)) findings.push({ where: `history:${sha.slice(0, 10)}:${path}:${h.line}`, detector: h.detector });
  }
}

if (findings.length) {
  for (const f of findings) console.error(`FAIL ${f.detector} at ${f.where}`);
  process.exit(1);
}
console.log(`OK no secret found in ${files.length} tracked files${blobs ? ` and ${blobs} history blobs` : ''}`);
