// SPDX-License-Identifier: Apache-2.0
//
// examples/openzeppelin/native-shielded in compact-runtime 0.20.0 (no chain):
//   * publishMetadata() emits exactly the metadata.json payload: kind 1, `domainSep` read from
//     `NativeShieldedToken__domain`, the same literals the constructor passed to initialize;
//   * the color: `rawTokenType(domainSep, contractAddress)` (official runtime) equals the color of the
//     coin `mint` creates (returned coin info and Zswap output), the token's own `tokenColor()` and
//     the color the reference consumer derives for the kind-1 identity; the mint effect is keyed by
//     the event's `domainSep`;
//   * rename, withdraw, repeated withdraw and revive: bytes and consumer state equal metadata.json;
//   * mint and burn emit nothing; Ownable guards every emitting circuit.

import { decodePayload, decodeUtf8, fromHex, toHex } from '@mip0018/codec';
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

const META = loadMetadata('native-shielded');
const CTOR = META.contract.constructorArgs as { domainSep: string; name_: string; symbol_: string; decimals_: number };
const DOMAIN = fromHex(CTOR.domainSep);
const OWNER = new Uint8Array(32).fill(0x0a);
const STRANGER = new Uint8Array(32).fill(0x0c);
const HOLDER_COIN_KEY = coinPublicKey(new Uint8Array(32).fill(0xb1));
const ADDRESS = exampleAddress('native-shielded');
const COLOR = colorOf(DOMAIN, ADDRESS);

type CoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };
type Maybe<T> = { is_some: boolean; value: T };

const managed = {} as Record<Variant, string>;
beforeAll(() => {
  managed['with-metadata'] = compileExample('native-shielded');
  managed['without-metadata'] = compileExample('native-shielded', { variant: 'without-metadata' });
}, 300_000);

const deploy = (variant: Variant = 'with-metadata'): Promise<Simulator<OzPrivateState>> =>
  deployAs(managed[variant], OWNER, [DOMAIN, CTOR.name_, CTOR.symbol_, BigInt(CTOR.decimals_), account(accountId(OWNER))], ADDRESS);

let nonceCounter = 0;
const nonce = (): Uint8Array => {
  const n = new Uint8Array(32);
  n[0] = ++nonceCounter;
  return n;
};

/** The circuit arguments of a metadata.json step. */
const argsOf = (step: Step): unknown[] => {
  if (step.circuit === 'setMetadata') return [utf8(step.args.newName as string), utf8(step.args.newSymbol as string)];
  if (step.circuit === 'mint') return [HOLDER_COIN_KEY, BigInt(step.args.amount as string), nonce()];
  return [];
};

describe('metadata.json', () => {
  it('every payload equals the reference encoder', () => {
    for (const step of [...META.steps, ...META.lifecycle])
      for (const e of step.events) expect(e.payload, step.id).toBe(toHex(encodeExpected(e)));
  });

  it('publishes the domainSep and the literals the constructor passes to NativeShieldedToken.initialize', () => {
    expect(META.identities).toEqual([
      { domainSep: CTOR.domainSep, kind: 1, name: CTOR.name_, symbol: CTOR.symbol_, decimals: CTOR.decimals_ },
    ]);
  });
});

describe('MyShieldedToken (OpenZeppelin NativeShieldedToken + Ownable + MIP-0018)', () => {
  it('publishMetadata() emits the metadata.json payload: kind 1, domainSep = NativeShieldedToken__domain', async () => {
    const sim = await deploy();
    const step = META.steps.find((s) => s.id === 'publish')!;
    const out = await callAs(sim, OWNER, 'publishMetadata');
    expectStepEvents(out, step, ADDRESS);
    const decoded = decodePayload(out.misc[0]!.payload);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(toHex(decoded.header.domainSep)).toBe(toHex(DOMAIN));
    expect(decoded.header.kind).toBe(1);
    expect(decoded.records.map((r) => (r.valType === 1 ? decodeUtf8(r.value) : r.value[0]))).toEqual([
      CTOR.name_,
      CTOR.symbol_,
      CTOR.decimals_,
    ]);
  });

  it('the minted coin has the color rawTokenType(domainSep, contractAddress), which the consumer derives from the event', async () => {
    const sim = await deploy();
    const minted = await callAs<CoinInfo>(sim, OWNER, 'mint', HOLDER_COIN_KEY, 1_000n, nonce());
    // The coin the circuit returns and the Zswap output it creates.
    expect(toHex(minted.result.color)).toBe(COLOR);
    const m = mintsOf(minted);
    expect(m.shieldedOutputs).toEqual([{ color: COLOR, value: 1_000n, recipientIsUser: true }]);
    // The mint effect a scanner reads: keyed by the domainSep, which is the event's domainSep.
    expect(m.shieldedMints).toEqual(new Map([[toHex(DOMAIN), 1_000n]]));
    expect([m.unshieldedMints.size, m.unshieldedOutputs.length]).toEqual([0, 0]);
    // OpenZeppelin's own getter agrees.
    expect(toHex((await callAs<Uint8Array>(sim, OWNER, 'tokenColor')).result)).toBe(COLOR);
    // The consumer derives the same color for the published kind-1 identity (never read from a value).
    const chain = new Chain();
    chain.apply(await callAs(sim, OWNER, 'publishMetadata'));
    const view = chain.identity(ADDRESS, CTOR.domainSep, 1)!;
    expect(view.colored).toBe(true);
    expect(toHex(view.color!)).toBe(COLOR);
    expect(view.domainSep).toBe([...m.shieldedMints.keys()][0]);
  });

  it('mint → publish (steps), then rename → withdraw → withdraw again → revive: bytes, mints and consumer state equal metadata.json', async () => {
    const sim = await deploy();
    const chain = new Chain();
    for (const step of [...META.steps, ...META.lifecycle]) {
      const out = await callAs(sim, OWNER, step.circuit, ...argsOf(step));
      expectStepEvents(out, step, ADDRESS);
      const m = mintsOf(out);
      expect([...m.shieldedMints].map(([d, a]) => ({ kind: 1, domainSep: `0x${d}`, amount: a.toString() }))).toEqual(step.mints ?? []);
      chain.apply(out);
      if (step.expected || META.steps.at(-1) === step)
        expect(sortedState(chain.snapshot(ADDRESS)), step.id).toEqual(sortedState(step.expected ?? META.expected));
    }
  });

  it.each(['with-metadata', 'without-metadata'] as Variant[])('mint and burn emit no event (normal operation) — %s', async (variant) => {
    const sim = await deploy(variant);
    const minted = await callAs<CoinInfo>(sim, OWNER, 'mint', HOLDER_COIN_KEY, 1_000n, nonce());
    // The holder pays the coin into the burn transaction; 400 are destroyed, 600 refunded.
    const burned = await callAs<Maybe<CoinInfo>>(sim, OWNER, 'burn', minted.result, 400n, HOLDER_COIN_KEY);
    for (const out of [minted, burned]) expect(out.events).toHaveLength(0);
    expect(burned.result.is_some).toBe(true);
    expect(burned.result.value.value).toBe(600n);
    expect(toHex(burned.result.value.color)).toBe(COLOR);
    expect(mintsOf(burned).shieldedMints.size).toBe(0);
  });

  it.each([
    ['publishMetadata', []],
    ['setMetadata', [utf8('Evil Shield'), utf8('EVIL')]],
    ['withdrawMetadata', []],
    ['mint', [coinPublicKey(new Uint8Array(32).fill(0xcc)), 1n, new Uint8Array(32).fill(0xee)]],
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
