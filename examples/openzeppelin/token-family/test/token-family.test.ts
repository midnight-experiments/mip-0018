// SPDX-License-Identifier: Apache-2.0
//
// examples/openzeppelin/token-family in compact-runtime 0.20.0 (no chain): one
// NativeShieldedTokenFamily contract, three token types (domainSep gold, silver, bronze).
//   * publishMetadata(domain) emits one event per identity, each = metadata.json;
//   * colors: each type's minted coin has the color rawTokenType(domain, contractAddress), distinct per
//     domain, which the consumer derives for that identity;
//   * reference consumer (MIP vectors S3/S6): three identities, one symbol group; withdrawing one type
//     hides only that one (a repeated withdraw changes nothing); renaming one moves only that one;
//     republishing revives it with the family values; untouched identities never change;
//   * mint emits nothing; Ownable guards every emitting circuit.

import { decodePayload, fromHex, toHex } from '@mip0018/codec';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileExample, type Variant } from '../../src/examples.ts';
import { expectStepEvents, sortedState } from '../../src/expect.ts';
import {
  account,
  accountId,
  callAs,
  Chain,
  coinPublicKey,
  colorOf,
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

const META = loadMetadata('token-family');
const CTOR = META.contract.constructorArgs as { name_: string; symbol_: string; decimals_: number };
const DOMAINS = META.identities.map((i) => i.domainSep); // gold, silver, bronze
const [GOLD, SILVER, BRONZE] = DOMAINS.map((d) => fromHex(d)) as [Uint8Array, Uint8Array, Uint8Array];
const OWNER = new Uint8Array(32).fill(0x0a);
const STRANGER = new Uint8Array(32).fill(0x0c);
const HOLDER_COIN_KEY = coinPublicKey(new Uint8Array(32).fill(0xb1));
const ADDRESS = exampleAddress('token-family');

type CoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };

const managed = {} as Record<Variant, string>;
beforeAll(() => {
  managed['with-metadata'] = compileExample('token-family');
  managed['without-metadata'] = compileExample('token-family', { variant: 'without-metadata' });
}, 300_000);

const deploy = (variant: Variant = 'with-metadata'): Promise<Simulator<OzPrivateState>> =>
  deployAs(managed[variant], OWNER, [CTOR.name_, CTOR.symbol_, BigInt(CTOR.decimals_), account(accountId(OWNER))], ADDRESS);

let nonceCounter = 0;
const nonce = (): Uint8Array => {
  const n = new Uint8Array(32);
  n[0] = ++nonceCounter;
  return n;
};

/** The circuit arguments of a metadata.json step. */
const argsOf = (step: Step): unknown[] => {
  const a = step.args;
  const domain = fromHex(a.domain as string);
  switch (step.circuit) {
    case 'mint':
      return [domain, HOLDER_COIN_KEY, BigInt(a.amount as string), nonce()];
    case 'setMetadata':
      return [domain, utf8(a.newName as string), utf8(a.newSymbol as string)];
    default:
      return [domain]; // publishMetadata, withdrawMetadata
  }
};

describe('metadata.json', () => {
  it('every payload equals the reference encoder', () => {
    for (const step of [...META.steps, ...META.lifecycle])
      for (const e of step.events) expect(e.payload, step.id).toBe(toHex(encodeExpected(e)));
  });

  it("three domains, each published with the family's constructor literals", () => {
    expect(new Set(DOMAINS).size).toBe(3);
    for (const i of META.identities)
      expect(i).toEqual({ domainSep: i.domainSep, kind: 1, name: CTOR.name_, symbol: CTOR.symbol_, decimals: CTOR.decimals_ });
  });
});

describe('MyTokenFamily (OpenZeppelin NativeShieldedTokenFamily + Ownable + MIP-0018)', () => {
  it('publishMetadata(domain) emits one event per identity, under that domain', async () => {
    const sim = await deploy();
    for (const [i, d] of [GOLD, SILVER, BRONZE].entries()) {
      const out = await callAs(sim, OWNER, 'publishMetadata', d);
      expectStepEvents(
        out,
        META.steps.find((s) => s.id === ['publish-gold', 'publish-silver', 'publish-bronze'][i])!,
        ADDRESS,
      );
      const decoded = decodePayload(out.misc[0]!.payload);
      if (!decoded.ok) throw new Error(decoded.reason);
      expect([toHex(decoded.header.domainSep), decoded.header.kind]).toEqual([toHex(d), 1]);
    }
  });

  it('each type has its own color rawTokenType(domain, address) = minted coin color = consumer color', async () => {
    const sim = await deploy();
    const chain = new Chain();
    const colors: string[] = [];
    for (const d of [GOLD, SILVER, BRONZE]) {
      const minted = await callAs<CoinInfo>(sim, OWNER, 'mint', d, HOLDER_COIN_KEY, 7n, nonce());
      const color = colorOf(d, ADDRESS);
      expect(toHex(minted.result.color)).toBe(color);
      expect(mintsOf(minted).shieldedOutputs.map((o) => o.color)).toEqual([color]);
      expect(mintsOf(minted).shieldedMints).toEqual(new Map([[toHex(d), 7n]]));
      expect(toHex((await callAs<Uint8Array>(sim, OWNER, 'tokenColor', d)).result)).toBe(color);
      chain.apply(await callAs(sim, OWNER, 'publishMetadata', d));
      expect(toHex(chain.identity(ADDRESS, toHex(d), 1)!.color!)).toBe(color);
      colors.push(color);
    }
    expect(new Set(colors).size).toBe(3);
  });

  it('steps then lifecycle: three identities, one group; withdraw / rename one type changes no other (metadata.json at every step)', async () => {
    const sim = await deploy();
    const chain = new Chain();
    for (const step of [...META.steps, ...META.lifecycle]) {
      const others = (ds: string[]) => ds.map((d) => chain.identity(ADDRESS, d, 1));
      const touched = step.events.map((e) => e.domainSep);
      const untouchedBefore = others(DOMAINS.filter((d) => !touched.includes(d)));
      const out = await callAs(sim, OWNER, step.circuit, ...argsOf(step));
      expectStepEvents(out, step, ADDRESS);
      const mints = [...mintsOf(out).shieldedMints].map(([d, a]) => ({ kind: 1, domainSep: `0x${d}`, amount: a.toString() }));
      expect(mints, step.id).toEqual(step.mints ?? []);
      chain.apply(out);
      expect(others(DOMAINS.filter((d) => !touched.includes(d))), step.id).toEqual(untouchedBefore);
      if (step.expected || META.steps.at(-1) === step)
        expect(sortedState(chain.snapshot(ADDRESS)), step.id).toEqual(sortedState(step.expected ?? META.expected));
    }
  });

  it.each(['with-metadata', 'without-metadata'] as Variant[])('mint emits no event (normal operation) — %s', async (variant) => {
    const sim = await deploy(variant);
    for (const d of [GOLD, SILVER, BRONZE])
      expect((await callAs(sim, OWNER, 'mint', d, HOLDER_COIN_KEY, 1n, nonce())).events).toHaveLength(0);
  });

  it.each([
    ['publishMetadata', [SILVER]],
    ['setMetadata', [GOLD, utf8('Evil Medals'), utf8('EVILM')]],
    ['withdrawMetadata', [BRONZE]],
    ['mint', [GOLD, coinPublicKey(new Uint8Array(32).fill(0xcc)), 1n, new Uint8Array(32).fill(0xee)]],
  ] as [string, unknown[]][])('a non-owner cannot call %s (Ownable assertion; nothing emitted)', async (circuit, args) => {
    const sim = await deploy();
    await expect(callAs(sim, STRANGER, circuit, ...args)).rejects.toThrow(/Ownable: caller is not the owner/u);
    const ok = await callAs(sim, OWNER, circuit, ...args);
    expect(ok.misc).toHaveLength(circuit === 'mint' ? 0 : 1);
  });

  it('the diff adds exactly the circuits publishMetadata, setMetadata and withdrawMetadata', () => {
    const without = deployedCircuits(managed['without-metadata']);
    const withMeta = deployedCircuits(managed['with-metadata']);
    expect(withMeta.filter((c) => !without.includes(c))).toEqual(['publishMetadata', 'setMetadata', 'withdrawMetadata']);
    expect(without.filter((c) => !withMeta.includes(c))).toEqual([]);
  });
});
