// SPDX-License-Identifier: Apache-2.0
//
// examples/minimal in compact-runtime 0.20.0 (no chain):
//   * publishMetadata emits exactly the A1 fixture (MIP Appendix A) in all three variants;
//   * normal token operations (mint, transfer) emit no Misc event (MIP "Publishing");
//   * OwnerKey: only the owner can publish / rename / withdraw / mint; a non-owner call fails its
//     assertion and emits nothing;
//   * PublishOnce: a second publishMetadata() fails;
//   * the OwnerKey lifecycle (publish -> rename -> withdraw) through the reference consumer.
// The on-chain create-and-destroy run (VerifierKeyRemove) is scripts/create-and-destroy.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent, commonRecords, encodePayload, EVENT_NAME, Kind, record, toHex } from '@mip0018/codec';
import { Simulator, type CallOutcome } from '@mip0018/compact/testing';
import { MetadataState } from '@mip0018/consumer';
import { beforeAll, describe, expect, it } from 'vitest';
import { CONTRACTS, compileMinimal, witnesses, type MinimalContract, type MinimalPrivateState } from '../src/contracts.ts';

const A1 = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'vectors', 'payload', 'A1.json'), 'utf8')) as {
  event: { name_hex: string; payload_hex: string };
};
const DOMAIN = new Uint8Array(32).fill(0x11); // MIP test A1's domainSep
const key = (b: number) => new Uint8Array(32).fill(b);
const ALICE = key(0xa1);
const BOB = key(0xb0);
const ps = (secretKey: Uint8Array): MinimalPrivateState => ({ secretKey });
const utf8 = (s: string) => new TextEncoder().encode(s);

const managed = {} as Record<MinimalContract, string>;
beforeAll(() => {
  for (const c of CONTRACTS) managed[c] = compileMinimal(c);
}, 300_000);

const deploy = async (c: MinimalContract, args: unknown[], caller: Uint8Array) =>
  Simulator.deploy<MinimalPrivateState>(managed[c], { witnesses, privateState: ps(caller), args });

/** accountId(sk) computed by the contract's own exported pure circuit. */
const accountId = (sim: Simulator<MinimalPrivateState>, sk: Uint8Array) => sim.module.pureCircuits.accountId!(sk) as Uint8Array;

const as = async <R>(
  sim: Simulator<MinimalPrivateState>,
  caller: Uint8Array,
  circuit: string,
  ...args: unknown[]
): Promise<CallOutcome<R>> => {
  sim.currentPrivateState = ps(caller);
  return sim.call<R>(circuit, ...args);
};

const expectA1 = (out: CallOutcome, address: string) => {
  expect(out.misc).toHaveLength(1);
  expect(out.misc[0]!.address).toBe(address);
  expect(toHex(out.misc[0]!.name)).toBe(A1.event.name_hex);
  expect(toHex(out.misc[0]!.payload)).toBe(A1.event.payload_hex);
};

const balance = (sim: Simulator<MinimalPrivateState>, account: Uint8Array): bigint => {
  const l = sim.ledger<{ Token_balances: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): bigint } }>();
  return l.Token_balances.member(account) ? l.Token_balances.lookup(account) : 0n;
};

describe('CreateAndDestroy', () => {
  const deployCD = async () => {
    const probe = await deploy('CreateAndDestroy', [DOMAIN, 0n, key(0)], ALICE);
    return deploy('CreateAndDestroy', [DOMAIN, 1000n, accountId(probe, ALICE)], ALICE);
  };

  it('publishMetadata() (unguarded) emits the A1 bytes; anyone can call it until its key is removed', async () => {
    const sim = await deployCD();
    expectA1(await as(sim, ALICE, 'publishMetadata'), sim.address);
    // Not access-controlled: another caller re-emits the SAME constant payload (harmless, at their cost).
    expectA1(await as(sim, BOB, 'publishMetadata'), sim.address);
  });

  it('transfer emits no Misc event (normal operation)', async () => {
    const sim = await deployCD();
    const bob = accountId(sim, BOB);
    const out = await as(sim, ALICE, 'transfer', bob, 250n);
    expect(out.events).toHaveLength(0);
    expect(balance(sim, accountId(sim, ALICE))).toBe(750n);
    expect(balance(sim, bob)).toBe(250n);
    await expect(as(sim, BOB, 'transfer', accountId(sim, ALICE), 251n)).rejects.toThrow(/MinimalToken: insufficient balance/u);
  });
});

describe('OwnerKey', () => {
  const deployOK = async () => {
    const probe = await deploy('OwnerKey', [DOMAIN, key(0)], ALICE);
    return deploy('OwnerKey', [DOMAIN, accountId(probe, ALICE)], ALICE);
  };

  it('the owner publishes the A1 bytes', async () => {
    const sim = await deployOK();
    expectA1(await as(sim, ALICE, 'publishMetadata'), sim.address);
  });

  it('setMetadata (rename) and withdrawMetadata (tombstone) equal the codec bytes', async () => {
    const sim = await deployOK();
    const renamed = await as(sim, ALICE, 'setMetadata', utf8('Beta Token'), utf8('BETA'));
    expect(toHex(renamed.misc[0]!.payload)).toBe(
      toHex(encodePayload({ domainSep: DOMAIN, kind: Kind.Ledger }, commonRecords({ name: 'Beta Token', symbol: 'BETA' }))),
    );
    const withdrawn = await as(sim, ALICE, 'withdrawMetadata');
    expect(toHex(withdrawn.misc[0]!.payload)).toBe(
      toHex(encodePayload({ domainSep: DOMAIN, kind: Kind.Ledger }, [record.tombstone('name')])),
    );
    for (const out of [renamed, withdrawn]) {
      expect(out.misc).toHaveLength(1);
      expect(toHex(out.misc[0]!.name)).toBe(toHex(EVENT_NAME));
      expect(classifyEvent({ type: 'Misc', name: out.misc[0]!.name, payload: out.misc[0]!.payload }).result).toBe('accept');
    }
  });

  it('mint and transfer emit no Misc event (normal operation)', async () => {
    const sim = await deployOK();
    const alice = accountId(sim, ALICE);
    const bob = accountId(sim, BOB);
    const minted = await as(sim, ALICE, 'mint', alice, 100n);
    const moved = await as(sim, ALICE, 'transfer', bob, 40n);
    expect(minted.events).toHaveLength(0);
    expect(moved.events).toHaveLength(0);
    expect([balance(sim, alice), balance(sim, bob)]).toEqual([60n, 40n]);
  });

  it.each([
    ['publishMetadata', []],
    ['setMetadata', [utf8('Evil Token'), utf8('EVIL')]],
    ['withdrawMetadata', []],
    ['mint', [new Uint8Array(32), 1n]],
  ] as [string, unknown[]][])('a non-owner cannot call %s (assertion; nothing emitted, state unchanged)', async (circuit, args) => {
    const sim = await deployOK();
    const before = sim.ledger<{ owner: Uint8Array }>().owner;
    await expect(as(sim, BOB, circuit, ...args)).rejects.toThrow(/OwnerKey: caller is not the owner/u);
    expect(sim.ledger<{ owner: Uint8Array }>().owner).toEqual(before);
    // The owner still can, so the failure was the guard and not the call.
    const ok = await as(sim, ALICE, circuit, ...args);
    expect(ok.misc.length).toBe(circuit === 'mint' ? 0 : 1);
  });

  it('publish -> rename -> withdraw -> republish, applied by the reference consumer', async () => {
    const sim = await deployOK();
    const steps = [
      await as(sim, ALICE, 'publishMetadata'),
      await as(sim, ALICE, 'setMetadata', utf8('Beta Token'), utf8('BETA')),
      await as(sim, ALICE, 'withdrawMetadata'),
    ];
    const state = new MetadataState();
    const view = () => state.identity('local', sim.address, DOMAIN, Kind.Ledger);
    const apply = (i: number, out: CallOutcome) =>
      state.apply({ network: 'local', contractAddress: sim.address, block: i + 1, tx: 0, event: 0, type: 'Misc', ...out.misc[0]! });
    expect(apply(0, steps[0]!).result).toBe('accept');
    expect(view()?.common).toEqual({ name: 'Acme Token', symbol: 'ACME', decimals: 6n, standards: ['mip-0004'] });
    apply(1, steps[1]!);
    expect(view()?.common).toEqual({ name: 'Beta Token', symbol: 'BETA', decimals: 6n, standards: ['mip-0004'] });
    apply(2, steps[2]!);
    expect(view()?.visible).toBe(false);
    apply(3, await as(sim, ALICE, 'publishMetadata'));
    expect(view()?.visible).toBe(true);
    expect(view()?.common).toEqual({ name: 'Acme Token', symbol: 'ACME', decimals: 6n, standards: ['mip-0004'] });
  });
});

describe('PublishOnce', () => {
  const deployPO = async () => {
    const probe = await deploy('PublishOnce', [DOMAIN, 0n, key(0)], ALICE);
    return deploy('PublishOnce', [DOMAIN, 1000n, accountId(probe, ALICE)], ALICE);
  };

  it('publishMetadata() emits the A1 bytes once; a second call fails and emits nothing', async () => {
    const sim = await deployPO();
    expectA1(await as(sim, BOB, 'publishMetadata'), sim.address); // whoever calls first: the payload is constant
    expect(sim.ledger<{ metadataPublished: boolean }>().metadataPublished).toBe(true);
    await expect(as(sim, ALICE, 'publishMetadata')).rejects.toThrow(/PublishOnce: metadata already published/u);
  });

  it('transfer emits no Misc event', async () => {
    const sim = await deployPO();
    const out = await as(sim, ALICE, 'transfer', accountId(sim, BOB), 1n);
    expect(out.events).toHaveLength(0);
  });
});
