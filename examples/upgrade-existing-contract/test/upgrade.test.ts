// SPDX-License-Identifier: Apache-2.0
//
// The upgrade template without a chain (compact-runtime 0.20.0): the deployed LegacyToken creates and changes the
// state; the upgrade-only LegacyTokenMetadata.publishMetadata() runs against THAT state and address, as it does on
// chain after the VerifierKeyInsert.
//
//   * LegacyToken has no MIP-0018 circuit; its mint emits nothing and returns a coin of color
//     tokenType(domain, address) — the color every existing holder has
//   * the upgrade's ledger() accessor decodes the deployed state exactly as LegacyToken's does (layout check, data side)
//   * publishMetadata() emits ONE event bound to the deployed address, with domainSep = the stored domain, kind 1 and
//     the literal common fields; it changes no ledger field; a non-owner cannot call it
//   * WHY the layout matters: an upgrade source with two fields swapped still compiles; its accessor reads other
//     values, its owner check fails, and an unguarded variant silently publishes metadata for the WRONG domainSep
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyEvent, commonRecords, encodePayload, EVENT_NAME, toHex } from '@mip0018/codec';
import { ensureCompiled, loadContractModule } from '@mip0018/compact/testing';
import { decodeDeployedLedger, decodedDifferences, tokenTypeHex, tokenTypeSha256 } from '@mip0018/midnight';
import { LEGACY, PUBLISHED, UPGRADE, compile, freshOwnerState, ownerId, witnesses, type OwnerState } from '../src/contracts.ts';
import { CALLER_COIN_PUBLIC_KEY, SharedState } from './harness.ts';

const DOMAIN = new Uint8Array(32).fill(0x5e);
const MODULE = join(import.meta.dirname, '..', '..', '..', 'packages', 'compact', 'src', 'Mip0018');
const tmp = mkdtempSync(join(tmpdir(), 'mip0018-upgrade-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let legacyDir: string;
let upgradeDir: string;
const owner: OwnerState = freshOwnerState();

beforeAll(() => {
  legacyDir = compile(LEGACY.name);
  upgradeDir = compile(UPGRADE.name);
}, 120_000);

/** Deploys LegacyToken and mints 1000 to the caller, as the issuer did long before the upgrade. */
async function deployedAndMinted() {
  const s = await SharedState.deploy(legacyDir, witnesses, owner, [DOMAIN, ownerId(owner.ownerSecret)]);
  const minted = await s.call<{ nonce: Uint8Array; color: Uint8Array; value: bigint }>(
    legacyDir,
    witnesses,
    'mint',
    { bytes: Uint8Array.from(Buffer.from(CALLER_COIN_PUBLIC_KEY, 'hex')) },
    1000n,
    new Uint8Array(32).fill(1),
  );
  return { s, minted };
}

const expectedPayload = (domainSep: Uint8Array) =>
  encodePayload(
    { domainSep, kind: PUBLISHED.kind },
    commonRecords({ name: PUBLISHED.name, symbol: PUBLISHED.symbol, decimals: PUBLISHED.decimals }),
  );

describe('legacy token (deployed before MIP-0018)', () => {
  it("TypeScript ownerId equals the contract's", async () => {
    const m = await loadContractModule(legacyDir);
    expect(toHex(m.pureCircuits.ownerId!(owner.ownerSecret) as Uint8Array)).toBe(toHex(ownerId(owner.ownerSecret)));
  });

  it('has no MIP-0018 circuit, mints coins of color tokenType(domain, address) and emits nothing', async () => {
    const info = JSON.parse(readFileSync(join(legacyDir, 'compiler', 'contract-info.json'), 'utf8')) as {
      circuits: { name: string; pure: boolean }[];
    };
    expect(info.circuits.filter((c) => !c.pure).map((c) => c.name)).toEqual(['mint']);
    const { s, minted } = await deployedAndMinted();
    expect(minted.events).toHaveLength(0);
    expect(minted.result.value).toBe(1000n);
    const color = toHex(minted.result.color);
    expect(color).toBe(tokenTypeHex(DOMAIN, s.address));
    expect(color).toBe(tokenTypeSha256(DOMAIN, s.address));
    const l = await s.ledger<{ domain: Uint8Array; totalMinted: bigint; mintCount: bigint }>(legacyDir);
    expect(toHex(l.domain)).toBe(toHex(DOMAIN));
    expect(l.totalMinted).toBe(1000n);
    expect(l.mintCount).toBe(1n);
  });
});

describe('upgrade-only source against the deployed state', () => {
  it('exports exactly one provable circuit: publishMetadata', () => {
    const info = JSON.parse(readFileSync(join(upgradeDir, 'compiler', 'contract-info.json'), 'utf8')) as {
      circuits: { name: string; pure: boolean }[];
    };
    expect(info.circuits.filter((c) => !c.pure).map((c) => c.name)).toEqual(['publishMetadata']);
  });

  it('decodes the deployed state exactly as the legacy accessor does (every field)', async () => {
    const { s } = await deployedAndMinted();
    const a = await decodeDeployedLedger(legacyDir, s.stateHex());
    const b = await decodeDeployedLedger(upgradeDir, s.stateHex());
    expect(a.map((f) => f.name)).toEqual(['domain', 'owner', 'totalMinted', 'mintCount']);
    expect(decodedDifferences(a, b)).toEqual([]);
  });

  it('publishMetadata() emits one event bound to the deployed address: stored domain, kind 1, the literal fields', async () => {
    const { s, minted } = await deployedAndMinted();
    const before = await decodeDeployedLedger(legacyDir, s.stateHex());
    const r = await s.call(upgradeDir, witnesses, 'publishMetadata');
    expect(r.misc).toHaveLength(1);
    const ev = r.misc[0]!;
    expect(ev.address).toBe(s.address);
    expect(toHex(ev.name)).toBe(toHex(EVENT_NAME));
    expect(toHex(ev.payload)).toBe(toHex(expectedPayload(DOMAIN)));
    const c = classifyEvent({ type: 'Misc', name: ev.name, payload: ev.payload });
    expect(c.result).toBe('accept');
    // The identity's color is the color of the coin minted before the upgrade.
    if (c.result === 'accept') expect(tokenTypeHex(c.header.domainSep, ev.address)).toBe(toHex(minted.result.color));
    // publishMetadata reads, never writes: the deployed state is unchanged, and LegacyToken still works on it.
    expect(decodedDifferences(before, await decodeDeployedLedger(legacyDir, s.stateHex()))).toEqual([]);
    const again = await s.call(legacyDir, witnesses, 'mint', { bytes: new Uint8Array(32).fill(7) }, 5n, new Uint8Array(32).fill(2));
    expect(again.events).toHaveLength(0);
    expect((await s.ledger<{ totalMinted: bigint }>(legacyDir)).totalMinted).toBe(1005n);
  });

  it('a non-owner cannot call publishMetadata() (nothing emitted, state unchanged)', async () => {
    const { s } = await deployedAndMinted();
    s.privateState = freshOwnerState();
    const before = s.stateHex();
    await expect(s.call(upgradeDir, witnesses, 'publishMetadata')).rejects.toThrow(/LegacyToken: caller is not the owner/u);
    expect(s.stateHex()).toBe(before);
  });
});

describe('why the layout must be identical', () => {
  // Same source with the first two ledger declarations (domain, owner — both Bytes<32>) swapped. It compiles.
  const source = readFileSync(UPGRADE.source, 'utf8').replace('"../../../packages/compact/src/Mip0018"', JSON.stringify(MODULE));
  const lines = source.split('\n');
  const iDomain = lines.findIndex((l) => l.startsWith('export sealed ledger domain'));
  const iOwner = lines.findIndex((l) => l.startsWith('export ledger owner'));
  [lines[iDomain], lines[iOwner]] = [lines[iOwner]!, lines[iDomain]!];
  const swapped = lines.join('\n');
  const unguarded = swapped.replace(/\n\s*assert\(ownerId\(ownerSecret\(\)\) == owner[^\n]*/u, '');

  const build = (name: string, text: string) => {
    const file = join(tmp, `${name}.compact`);
    writeFileSync(file, text);
    return ensureCompiled(file, join(tmp, 'managed', name));
  };

  it('a swapped upgrade decodes other values under the same names', async () => {
    const dir = build('Swapped', swapped);
    const { s } = await deployedAndMinted();
    const diff = decodedDifferences(await decodeDeployedLedger(legacyDir, s.stateHex()), await decodeDeployedLedger(dir, s.stateHex()));
    expect(diff.map((d) => d.split(':')[0])).toEqual(['domain', 'owner']);
  });

  it("a swapped upgrade's owner check reads the domain, so the owner is refused", async () => {
    const dir = build('Swapped', swapped);
    const { s } = await deployedAndMinted();
    await expect(s.call(dir, witnesses, 'publishMetadata')).rejects.toThrow(/caller is not the owner/u);
  });

  it('an unguarded swapped upgrade SILENTLY publishes metadata for the wrong domainSep (the owner id)', async () => {
    const dir = build('SwappedUnguarded', unguarded);
    expect(readFileSync(join(tmp, 'SwappedUnguarded.compact'), 'utf8')).not.toContain('assert(ownerId');
    const { s } = await deployedAndMinted();
    const r = await s.call(dir, witnesses, 'publishMetadata');
    expect(r.misc).toHaveLength(1);
    const c = classifyEvent({ type: 'Misc', name: r.misc[0]!.name, payload: r.misc[0]!.payload });
    expect(c.result).toBe('accept'); // a valid event…
    if (c.result === 'accept') {
      expect(toHex(c.header.domainSep)).toBe(toHex(ownerId(owner.ownerSecret))); // …for an identity nobody holds
      expect(toHex(c.header.domainSep)).not.toBe(toHex(DOMAIN));
    }
  });
});
