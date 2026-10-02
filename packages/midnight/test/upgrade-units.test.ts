// SPDX-License-Identifier: Apache-2.0
//
// Existing-contract upgrade helpers without a chain: who can sign a VerifierKeyInsert (checkAuthority), maintenance
// key files, and the layout comparison on synthetic compiler layouts.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ContractMaintenanceAuthority, sampleSigningKey, signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { compareLayouts, fieldText, type Layout } from '../src/layout.ts';
import { checkAuthority, readMaintenanceKeyFile } from '../src/signer/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'mip0018-upgrade-units-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('checkAuthority (who can sign a VerifierKeyInsert)', () => {
  const me = sampleSigningKey();
  const other = sampleSigningKey();
  it('accepts the single committee key (threshold 1) and gives its signature index', () => {
    const r = checkAuthority(new ContractMaintenanceAuthority([signatureVerifyingKey(other), signatureVerifyingKey(me)], 1, 3n), me);
    expect(r).toMatchObject({ ok: true, index: 1, committeeSize: 2, threshold: 1, counter: '3' });
  });
  it('refuses a frozen authority (empty committee, the ledger default)', () => {
    const r = checkAuthority(new ContractMaintenanceAuthority([], 1), me);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/frozen maintenance authority/u);
  });
  it('refuses a key outside the committee', () => {
    const r = checkAuthority(new ContractMaintenanceAuthority([signatureVerifyingKey(other)], 1), me);
    expect(r).toMatchObject({ ok: false, index: -1 });
    expect(r.reason).toMatch(/not in the contract's committee/u);
  });
  it('refuses when more than one signature is needed, or the threshold cannot be met', () => {
    const two = [signatureVerifyingKey(me), signatureVerifyingKey(other)];
    expect(checkAuthority(new ContractMaintenanceAuthority(two, 2), me).reason).toMatch(/needs 2 signatures/u);
    expect(checkAuthority(new ContractMaintenanceAuthority(two, 3), me).reason).toMatch(/exceeds its committee/u);
  });
});

describe('readMaintenanceKeyFile', () => {
  const key = sampleSigningKey();
  const file = (name: string, text: string, mode = 0o600) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };
  it('reads the private-state JSON form and bare hex (schnorr)', () => {
    expect(readMaintenanceKeyFile(file('k.json', JSON.stringify(key)))).toEqual(key);
    expect(readMaintenanceKeyFile(file('k.hex', `${key.value.toUpperCase()}\n`))).toEqual({ tag: 'schnorr', value: key.value });
  });
  it('refuses a group/other-readable file and malformed content (never echoing it)', () => {
    expect(() => readMaintenanceKeyFile(file('open.json', JSON.stringify(key), 0o644))).toThrow(/chmod 600/u);
    const bad = file('bad.txt', 'not a key');
    expect(() => readMaintenanceKeyFile(bad)).toThrow(/not a maintenance key file/u);
    try {
      readMaintenanceKeyFile(file('bad2.json', '{"tag":"rsa","value":"00"}'));
    } catch (e) {
      expect(String(e)).not.toContain('"value"');
    }
  });
});

describe('compareLayouts (synthetic compiler layouts)', () => {
  const layout = (fields: Layout['fields'], compiler = '0.35.0'): Layout => ({ from: 'x', compiler, language: '0.27.0', fields });
  const bytes32 = { 'type-name': 'Bytes', length: 32 };
  const u128 = { 'type-name': 'Uint', maxval: 2 ** 128 - 1 };
  const deployed = layout([
    { name: 'domain', index: 0, exported: true, storage: 'Cell', type: bytes32 },
    { name: 'total', index: 1, exported: true, storage: 'Cell', type: u128 },
    { name: 'm', index: 2, exported: false, storage: 'Map', key: bytes32, value: u128 },
  ]);
  it('renders Compact-like field types', () => {
    expect(deployed.fields.map(fieldText)).toEqual(['domain: Cell<Bytes<32>>', 'total: Cell<Uint<128>>', 'm: Map<Bytes<32>, Uint<128>>']);
  });
  it('identical layouts pass; `exported` and the compiler version are notes', () => {
    const c = compareLayouts(
      deployed,
      layout(
        deployed.fields.map((f) => ({ ...f, exported: true })),
        '0.36.0',
      ),
    );
    expect(c.identical).toBe(true);
    expect(c.notes.join('\n')).toMatch(/#2 m: exported false vs true/u);
    expect(c.notes.join('\n')).toMatch(/different compilers/u);
  });
  it('a map value type change is a mismatch', () => {
    const c = compareLayouts(deployed, layout(deployed.fields.map((f) => (f.name === 'm' ? { ...f, value: bytes32 } : f))));
    expect(c.identical).toBe(false);
    expect(c.problems).toEqual(['#2: deployed m: Map<Bytes<32>, Uint<128>>, upgrade m: Map<Bytes<32>, Bytes<32>>']);
  });
});
