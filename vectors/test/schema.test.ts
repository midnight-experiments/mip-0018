// Every fixture validates against its JSON Schema; schemas reject malformed vectors.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VECTORS_DIR } from '../tools/common.ts';
import { makeAjv, validateAll } from '../tools/validate.ts';

const BASE = 'https://github.com/midnight-experiments/mip-0018/vectors/schema/';

describe('schemas', () => {
  it('every vector, the manifest and every derived runner request are valid', () => {
    const { errors, checked } = validateAll();
    expect(errors).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  const ajv = makeAjv();
  const payload = ajv.getSchema(`${BASE}payload.schema.json`)!;
  const state = ajv.getSchema(`${BASE}state.schema.json`)!;
  const response = ajv.getSchema(`${BASE}runner.schema.json#/$defs/response`)!;
  const a1 = JSON.parse(readFileSync(join(VECTORS_DIR, 'payload/A1.json'), 'utf8'));
  const s1a = JSON.parse(readFileSync(join(VECTORS_DIR, 'state/S1a.json'), 'utf8'));

  it('rejects a normative payload vector with a short payload or name; accepts them in an informative vector', () => {
    expect(payload({ ...a1, event: { ...a1.event, payload_hex: '00' } })).toBe(false);
    expect(payload({ ...a1, event: { ...a1.event, name_hex: a1.event.name_hex.slice(0, 54) } })).toBe(false);
    const informative = { ...a1, normative: false, mip: { ...a1.mip, testId: 'INF-ZEXT' }, basis: 'MIP "Consuming"' };
    expect(payload({ ...informative, event: { ...a1.event, payload_hex: a1.event.payload_hex.slice(0, 190) } })).toBe(true);
    expect(payload({ ...informative, event: { ...a1.event, payload_hex: 'zz' } })).toBe(false);
  });
  it('rejects a normative state step with a short payload', () => {
    const bad = structuredClone(s1a);
    bad.steps[0].payload_hex = bad.steps[0].payload_hex.slice(0, 100);
    expect(state(bad)).toBe(false);
    expect(state({ ...bad, normative: false, basis: 'x' })).toBe(true);
  });
  it('rejects an accept expectation without records', () => {
    expect(payload({ ...a1, expect: { result: 'accept', header: a1.expect.header, contentEnd: 95 } })).toBe(false);
  });
  it('rejects a reject expectation that carries records', () => {
    expect(payload({ ...a1, expect: { result: 'reject', reason: 'bad-kind', records: a1.expect.records } })).toBe(false);
  });
  it('rejects a vector pinned to another MIP commit', () => {
    expect(payload({ ...a1, mip: { commit: '0'.repeat(40), testId: 'A1' } })).toBe(false);
  });
  it('rejects a state step with an unknown op', () => {
    expect(state({ ...s1a, steps: [{ op: 'reorg' }] })).toBe(false);
  });
  it('rejects a Null (type 5) as a stored field', () => {
    const bad = structuredClone(s1a);
    bad.expect.identities[0].fields['6e616d65'].valType = 5;
    expect(state(bad)).toBe(false);
  });
  it('rejects an expected identity without fields or with an unknown property', () => {
    const empty = structuredClone(s1a);
    empty.expect.identities[0].fields = {};
    expect(state(empty)).toBe(false);
    const unknown = structuredClone(s1a);
    unknown.expect.identities[0].hidden = true;
    expect(state(unknown)).toBe(false);
  });
  it('a runner response with an identity without fields is invalid', () => {
    const id = { network: 'testnet-a', contractAddress: 'aa'.repeat(32), domainSep: '11'.repeat(32), kind: 1 };
    expect(response({ id: 'S3c', identities: [{ ...id, fields: {} }] })).toBe(false);
    expect(response({ id: 'S3c', identities: [{ ...id, fields: { '6e616d65': { valType: 1, value_hex: '41' } } }] })).toBe(true);
  });
  it('accepts runner responses of each shape', () => {
    expect(response({ id: 'A1', result: 'reject', reason: 'x' })).toBe(true);
    expect(response({ id: 'S1a', identities: [] })).toBe(true);
    expect(response({ id: null, error: 'bad request' })).toBe(true);
  });
});
