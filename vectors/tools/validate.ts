#!/usr/bin/env node
/**
 * Validates every vector against its JSON Schema (2020-12), the manifest against its schema, every runner request
 * derived from a vector against the runner protocol schema, and the .bin files against their JSON hex.
 *
 *   node vectors/tools/validate.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { toHex } from './bytes.ts';
import { listFiles, MANIFEST_FILE, VECTORS_DIR } from './common.ts';
import { loadVectors, readManifest, requestFor, type Json } from './runner-core.ts';

const SCHEMA_BASE = 'https://github.com/midnight-experiments/mip-0018/vectors/schema/';

export function makeAjv(dir: string = VECTORS_DIR): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  for (const name of ['payload', 'state', 'runner', 'manifest']) {
    ajv.addSchema(JSON.parse(readFileSync(join(dir, 'schema', `${name}.schema.json`), 'utf8')) as object);
  }
  return ajv;
}

export function validateAll(dir: string = VECTORS_DIR): { errors: string[]; checked: number } {
  const ajv = makeAjv(dir);
  const errors: string[] = [];
  let checked = 0;
  const validator = (ref: string) => {
    const v = ajv.getSchema(`${SCHEMA_BASE}${ref}`);
    if (v === undefined) throw new Error(`schema not found: ${ref}`);
    return v;
  };
  const payloadV = validator('payload.schema.json');
  const stateV = validator('state.schema.json');
  const requestV = validator('runner.schema.json#/$defs/request');
  const manifestV = validator('manifest.schema.json');

  const manifest = readManifest(dir);
  checked++;
  if (!manifestV(manifest)) errors.push(`${MANIFEST_FILE}: ${ajv.errorsText(manifestV.errors)}`);

  const listed = new Set<string>();
  for (const v of loadVectors({ dir })) {
    listed.add(v.entry.file);
    checked++;
    const validate = v.entry.kind === 'payload' ? payloadV : stateV;
    if (!validate(v.data)) errors.push(`${v.entry.file}: ${ajv.errorsText(validate.errors)}`);
    if (v.data.id !== v.entry.id) errors.push(`${v.entry.file}: id ${String(v.data.id)} != manifest id ${v.entry.id}`);
    if ((v.data.mip as Json | undefined)?.testId !== v.entry.testId) errors.push(`${v.entry.file}: testId differs from the manifest`);
    if (v.data.normative !== v.entry.normative) errors.push(`${v.entry.file}: normative flag differs from the manifest`);
    const req = requestFor(v);
    if (!requestV(req)) errors.push(`${v.entry.file}: derived runner request invalid: ${ajv.errorsText(requestV.errors)}`);
    if (v.entry.bin !== undefined) {
      listed.add(v.entry.bin);
      const bin = readFileSync(join(dir, v.entry.bin));
      const ev = v.data.event as Json;
      if (v.entry.normative && bin.length !== 256) errors.push(`${v.entry.bin}: ${bin.length} bytes, expected 256`);
      if (toHex(bin) !== ev.payload_hex) errors.push(`${v.entry.bin}: bytes differ from payload_hex in ${v.entry.file}`);
    }
  }
  const vectorFiles = ['payload', 'state', 'informative/state', 'informative/uri', 'informative/zero-extension']
    .flatMap((d) => listFiles(d, dir))
    .filter((f) => /\/[^/]+\.(json|bin)$/.test(f) && !f.includes('/investigation/') && !f.endsWith('/verdicts.json'));
  for (const f of vectorFiles) if (!listed.has(f)) errors.push(`${f}: not listed in ${MANIFEST_FILE}`);
  return { errors, checked };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, checked } = validateAll();
  if (errors.length > 0) {
    console.error(`vectors validate: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  ${e}`);
    process.exitCode = 1;
  } else {
    console.log(`vectors validate: OK — ${checked} documents valid (payload/state/manifest schemas, runner requests, .bin files)`);
  }
}
