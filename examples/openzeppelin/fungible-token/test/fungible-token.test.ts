// SPDX-License-Identifier: Apache-2.0
//
// examples/openzeppelin/fungible-token in compact-runtime 0.20.0 (no chain):
//   * publishMetadata() emits exactly the metadata.json payload (kind 3, constant domainSep, decimals
//     from the token's state) — the same literals the constructor passed to FungibleToken.initialize;
//   * rename, withdraw (a Null record for each key), repeated withdraw and revive: bytes and reference-consumer state
//     equal metadata.json after every step; no color for kind 3;
//   * mint, transfer and burn emit nothing (MIP "Publishing: no events in normal operation");
//   * Ownable: a non-owner cannot publish, rename, withdraw, mint or burn (nothing emitted).

import { decodePayload, decodeUtf8, toHex } from '@mip0018/codec';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileExample, type Variant } from '../../src/examples.ts';
import { expectStepEvents, sortedState } from '../../src/expect.ts';
import {
  account,
  accountId,
  callAs,
  Chain,
  deployAs,
  deployedCircuits,
  encodeExpected,
  exampleAddress,
  loadMetadata,
  mintsOf,
  utf8,
  type OzPrivateState,
  type Simulator,
  type Step,
} from '../../src/testing.ts';

const META = loadMetadata('fungible-token');
const CTOR = META.contract.constructorArgs as { name_: string; symbol_: string; decimals_: number };
const OWNER = new Uint8Array(32).fill(0x0a);
const HOLDER = new Uint8Array(32).fill(0x0b);
const STRANGER = new Uint8Array(32).fill(0x0c);
const ADDRESS = exampleAddress('fungible-token');

const managed = {} as Record<Variant, string>;
beforeAll(() => {
  managed['with-metadata'] = compileExample('fungible-token');
  managed['without-metadata'] = compileExample('fungible-token', { variant: 'without-metadata' });
}, 300_000);

const deploy = (variant: Variant = 'with-metadata'): Promise<Simulator<OzPrivateState>> =>
  deployAs(managed[variant], OWNER, [CTOR.name_, CTOR.symbol_, BigInt(CTOR.decimals_), account(accountId(OWNER))], ADDRESS);

/** The circuit arguments of a metadata.json step. */
const argsOf = (step: Step): unknown[] =>
  step.circuit === 'setMetadata' ? [utf8(step.args.newName as string), utf8(step.args.newSymbol as string)] : [];

describe('metadata.json', () => {
  it('every payload equals the reference encoder', () => {
    for (const step of [...META.steps, ...META.lifecycle])
      for (const e of step.events) expect(e.payload, `${step.id}`).toBe(toHex(encodeExpected(e)));
  });

  it('publishes the same literals the constructor passes to FungibleToken.initialize', () => {
    expect(META.identities).toEqual([{ ...META.identities[0], name: CTOR.name_, symbol: CTOR.symbol_, decimals: CTOR.decimals_ }]);
    expect(META.steps[0]!.events[0]).toMatchObject(META.identities[0]!);
  });
});

describe('MyFungibleToken (OpenZeppelin FungibleToken + Ownable + MIP-0018)', () => {
  it('publishMetadata() emits the metadata.json payload: kind 3, constant domainSep, the constructor literals', async () => {
    const sim = await deploy();
    const out = await callAs(sim, OWNER, 'publishMetadata');
    expectStepEvents(out, META.steps[0]!, ADDRESS);
    const decoded = decodePayload(out.misc[0]!.payload);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(toHex(decoded.header.domainSep)).toBe(META.identities[0]!.domainSep.slice(2));
    expect(decoded.header.kind).toBe(3);
    const [name, symbol, decimals] = decoded.records;
    expect(decodeUtf8(name!.value)).toBe(CTOR.name_);
    expect(decodeUtf8(symbol!.value)).toBe(CTOR.symbol_);
    expect(decimals!.value).toEqual(Uint8Array.of(CTOR.decimals_)); // FungibleToken__decimals, Uint<8>
  });

  it('publish → rename → withdraw → withdraw again → revive: bytes and consumer state equal metadata.json', async () => {
    const sim = await deploy();
    const chain = new Chain();
    for (const step of [...META.steps, ...META.lifecycle]) {
      const out = await callAs(sim, OWNER, step.circuit, ...argsOf(step));
      expectStepEvents(out, step, ADDRESS);
      chain.apply(out);
      expect(sortedState(chain.snapshot(ADDRESS)), step.id).toEqual(sortedState(step.expected ?? META.expected));
    }
  });

  it('kind 3 has no color, and the token mints nothing native', async () => {
    const sim = await deploy();
    const chain = new Chain();
    chain.apply(await callAs(sim, OWNER, 'publishMetadata'));
    const view = chain.identity(ADDRESS, META.identities[0]!.domainSep, 3)!;
    expect(view.colored).toBe(false);
    expect(view.color).toBeNull();
    const m = mintsOf(await callAs(sim, OWNER, 'mint', account(accountId(HOLDER)), 1n));
    expect([m.shieldedMints.size, m.unshieldedMints.size, m.shieldedOutputs.length, m.unshieldedOutputs.length]).toEqual([0, 0, 0, 0]);
  });

  it.each(['with-metadata', 'without-metadata'] as Variant[])(
    'mint, transfer and burn emit no event (normal operation) — %s',
    async (variant) => {
      const sim = await deploy(variant);
      const holder = account(accountId(HOLDER));
      const outs = [
        await callAs(sim, OWNER, 'mint', holder, 1_000n),
        await callAs(sim, HOLDER, 'transfer', account(accountId(STRANGER)), 300n),
        await callAs(sim, OWNER, 'burn', holder, 200n),
      ];
      for (const out of outs) expect(out.events).toHaveLength(0);
      expect((await callAs(sim, OWNER, 'balanceOf', holder)).result).toBe(500n);
      expect((await callAs(sim, OWNER, 'balanceOf', account(accountId(STRANGER)))).result).toBe(300n);
    },
  );

  it.each([
    ['publishMetadata', []],
    ['setMetadata', [utf8('Evil Coin'), utf8('EVIL')]],
    ['withdrawMetadata', []],
    ['mint', [account(new Uint8Array(32).fill(0x0c)), 1n]],
    ['burn', [account(new Uint8Array(32).fill(0x0b)), 1n]],
  ] as [string, unknown[]][])('a non-owner cannot call %s (Ownable assertion; nothing emitted)', async (circuit, args) => {
    const sim = await deploy();
    if (circuit === 'burn') await callAs(sim, OWNER, 'mint', args[0], 5n);
    await expect(callAs(sim, STRANGER, circuit, ...args)).rejects.toThrow(/Ownable: caller is not the owner/u);
    // The owner can, so the failure was the guard and not the call.
    const ok = await callAs(sim, OWNER, circuit, ...args);
    expect(ok.misc).toHaveLength(['mint', 'burn'].includes(circuit) ? 0 : 1);
  });

  it('the diff adds exactly the circuits publishMetadata, setMetadata and withdrawMetadata', () => {
    const without = deployedCircuits(managed['without-metadata']);
    const withMeta = deployedCircuits(managed['with-metadata']);
    expect(withMeta.filter((c) => !without.includes(c))).toEqual(['publishMetadata', 'setMetadata', 'withdrawMetadata']);
    expect(without.filter((c) => !withMeta.includes(c))).toEqual([]);
  });
});
