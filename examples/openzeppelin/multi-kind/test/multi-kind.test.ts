// SPDX-License-Identifier: Apache-2.0
//
// examples/openzeppelin/multi-kind in compact-runtime 0.20.0 (no chain): one asset as kinds 1, 2
// and 3 under one domainSep and one symbol.
//   * publishMetadata() emits three events in one call (kinds 1, 2, 3), each = metadata.json;
//   * colors: the shielded coin and the unshielded UTXO have the SAME color,
//     rawTokenType(domainSep, contractAddress), which the consumer derives for kinds 1 and 2; kind 3
//     has none;
//   * reference consumer (MIP vectors S6/S9): three identities, one symbol group; renaming one member
//     changes no other; a new symbol moves only that member; withdrawing one hides only that one;
//     a second deployment (same domainSep, same symbol) never joins the first one's identities or group;
//   * mints and transfers emit nothing; Ownable guards every emitting circuit; a bad kind is refused.

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

const META = loadMetadata('multi-kind');
const CTOR = META.contract.constructorArgs as { domainSep: string; name_: string; symbol_: string; decimals_: number };
const DOMAIN = fromHex(CTOR.domainSep);
const OWNER = new Uint8Array(32).fill(0x0a);
const HOLDER = new Uint8Array(32).fill(0x0b);
const STRANGER = new Uint8Array(32).fill(0x0c);
const HOLDER_COIN_KEY = coinPublicKey(new Uint8Array(32).fill(0xb1));
const HOLDER_USER_ADDRESS = { bytes: new Uint8Array(32).fill(0xb2) };
const ADDRESS = exampleAddress('multi-kind');
const OTHER_ADDRESS = exampleAddress('multi-kind:second-deployment');
const COLOR = colorOf(DOMAIN, ADDRESS);

type CoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };

const managed = {} as Record<Variant, string>;
beforeAll(() => {
  managed['with-metadata'] = compileExample('multi-kind');
  managed['without-metadata'] = compileExample('multi-kind', { variant: 'without-metadata' });
}, 300_000);

const deploy = (variant: Variant = 'with-metadata', address = ADDRESS): Promise<Simulator<OzPrivateState>> =>
  deployAs(managed[variant], OWNER, [DOMAIN, CTOR.name_, CTOR.symbol_, BigInt(CTOR.decimals_), account(accountId(OWNER))], address);

let nonceCounter = 0;
const nonce = (): Uint8Array => {
  const n = new Uint8Array(32);
  n[0] = ++nonceCounter;
  return n;
};

/** The circuit arguments of a metadata.json step. */
const argsOf = (step: Step): unknown[] => {
  const a = step.args;
  switch (step.circuit) {
    case 'mintShielded':
      return [HOLDER_COIN_KEY, BigInt(a.amount as string), nonce()];
    case 'mintUnshielded':
      return [HOLDER_USER_ADDRESS, BigInt(a.amount as string)];
    case 'mintLedger':
      return [account(accountId(HOLDER)), BigInt(a.value as string)];
    case 'setMetadata':
      return [BigInt(a.kind as number), utf8(a.newName as string), utf8(a.newSymbol as string)];
    case 'withdrawMetadata':
      return [BigInt(a.kind as number)];
    default:
      return [];
  }
};

/** Native mint effects of a call in metadata.json form. */
const mintList = (s: Awaited<ReturnType<typeof mintsOf>>) => [
  ...[...s.shieldedMints].map(([d, a]) => ({ kind: 1, domainSep: `0x${d}`, amount: a.toString() })),
  ...[...s.unshieldedMints].map(([d, a]) => ({ kind: 2, domainSep: `0x${d}`, amount: a.toString() })),
];

describe('metadata.json', () => {
  it('every payload equals the reference encoder', () => {
    for (const step of [...META.steps, ...META.lifecycle])
      for (const e of step.events) expect(e.payload, step.id).toBe(toHex(encodeExpected(e)));
  });

  it('one domainSep, one name, one symbol, one decimals for kinds 1, 2 and 3 — the constructor literals', () => {
    const one = { domainSep: CTOR.domainSep, name: CTOR.name_, symbol: CTOR.symbol_, decimals: CTOR.decimals_ };
    expect(META.identities).toEqual([1, 2, 3].map((kind) => ({ ...one, kind })));
  });
});

describe('MyMultiKindToken (OpenZeppelin NativeShieldedToken + FungibleToken + std-lib unshielded mint + Ownable + MIP-0018)', () => {
  it('publishMetadata() emits three events in one call: kinds 1, 2, 3 under one domainSep', async () => {
    const sim = await deploy();
    const out = await callAs(sim, OWNER, 'publishMetadata');
    expectStepEvents(
      out,
      META.steps.find((s) => s.id === 'publish')!,
      ADDRESS,
    );
    const headers = out.misc.map((m) => {
      const d = decodePayload(m.payload);
      if (!d.ok) throw new Error(d.reason);
      return [toHex(d.header.domainSep), d.header.kind];
    });
    expect(headers).toEqual([1, 2, 3].map((k) => [toHex(DOMAIN), k]));
  });

  it('shielded coin and unshielded UTXO share one color, rawTokenType(domainSep, address); kind 3 has none', async () => {
    const sim = await deploy();
    const shielded = await callAs<CoinInfo>(sim, OWNER, 'mintShielded', HOLDER_COIN_KEY, 50n, nonce());
    const unshielded = await callAs<Uint8Array>(sim, OWNER, 'mintUnshielded', HOLDER_USER_ADDRESS, 70n);
    const ledger = await callAs(sim, OWNER, 'mintLedger', account(accountId(HOLDER)), 90n);
    expect(toHex(shielded.result.color)).toBe(COLOR);
    expect(toHex(unshielded.result)).toBe(COLOR);
    expect(mintsOf(shielded).shieldedOutputs.map((o) => o.color)).toEqual([COLOR]);
    expect(mintsOf(unshielded).unshieldedOutputs.map((o) => o.color)).toEqual([COLOR]);
    expect(mintList(mintsOf(shielded))).toEqual([{ kind: 1, domainSep: CTOR.domainSep, amount: '50' }]);
    expect(mintList(mintsOf(unshielded))).toEqual([{ kind: 2, domainSep: CTOR.domainSep, amount: '70' }]);
    expect(mintList(mintsOf(ledger))).toEqual([]);

    const chain = new Chain();
    chain.apply(await callAs(sim, OWNER, 'publishMetadata'));
    const [k1, k2, k3] = [1, 2, 3].map((k) => chain.identity(ADDRESS, CTOR.domainSep, k)!);
    expect([toHex(k1!.color!), toHex(k2!.color!)]).toEqual([COLOR, COLOR]);
    expect([k3!.colored, k3!.color]).toEqual([false, null]);
  });

  it('steps then lifecycle: three identities, one group; rename/withdraw one member changes no other (metadata.json at every step)', async () => {
    const sim = await deploy();
    const chain = new Chain();
    for (const step of [...META.steps, ...META.lifecycle]) {
      const others = (kinds: number[]) => kinds.map((k) => chain.identity(ADDRESS, CTOR.domainSep, k));
      const touched = step.events.map((e) => e.kind);
      const untouchedBefore = others([1, 2, 3].filter((k) => !touched.includes(k as 1 | 2 | 3)));
      const out = await callAs(sim, OWNER, step.circuit, ...argsOf(step));
      expectStepEvents(out, step, ADDRESS);
      expect(mintList(mintsOf(out)), step.id).toEqual(step.mints ?? []);
      chain.apply(out);
      // An update to one member changes no other member (same fields, same positions).
      expect(others([1, 2, 3].filter((k) => !touched.includes(k as 1 | 2 | 3))), step.id).toEqual(untouchedBefore);
      if (step.expected || META.steps.at(-1) === step)
        expect(sortedState(chain.snapshot(ADDRESS)), step.id).toEqual(sortedState(step.expected ?? META.expected));
    }
  });

  it('a second deployment with the same domainSep and symbol: separate identities, separate group, different color', async () => {
    const chain = new Chain();
    const first = await deploy('with-metadata', ADDRESS);
    const second = await deploy('with-metadata', OTHER_ADDRESS);
    chain.apply(await callAs(first, OWNER, 'publishMetadata'));
    chain.apply(await callAs(second, OWNER, 'publishMetadata'));
    expect(chain.state.identities()).toHaveLength(6);
    const groups = chain.state.groups();
    expect(groups.map((g) => [g.contractAddress, g.members.length])).toEqual([
      [ADDRESS, 3],
      [OTHER_ADDRESS, 3],
    ]);
    const otherColor = toHex(chain.identity(OTHER_ADDRESS, CTOR.domainSep, 1)!.color!);
    expect(otherColor).toBe(colorOf(DOMAIN, OTHER_ADDRESS));
    expect(otherColor).not.toBe(COLOR);
  });

  it.each(['with-metadata', 'without-metadata'] as Variant[])(
    'mints of all three kinds and transfer emit no event — %s',
    async (variant) => {
      const sim = await deploy(variant);
      const outs = [
        await callAs(sim, OWNER, 'mintShielded', HOLDER_COIN_KEY, 1n, nonce()),
        await callAs(sim, OWNER, 'mintUnshielded', HOLDER_USER_ADDRESS, 1n),
        await callAs(sim, OWNER, 'mintLedger', account(accountId(HOLDER)), 10n),
        await callAs(sim, HOLDER, 'transfer', account(accountId(STRANGER)), 4n),
      ];
      for (const out of outs) expect(out.events).toHaveLength(0);
      expect((await callAs(sim, OWNER, 'balanceOf', account(accountId(STRANGER)))).result).toBe(4n);
    },
  );

  it.each([0n, 4n, 255n])('setMetadata / withdrawMetadata refuse kind %s (nothing emitted)', async (kind) => {
    const sim = await deploy();
    await expect(callAs(sim, OWNER, 'setMetadata', kind, utf8('Acme Dollar'), utf8('ACD'))).rejects.toThrow(/kind must be 1, 2 or 3/u);
    await expect(callAs(sim, OWNER, 'withdrawMetadata', kind)).rejects.toThrow(/kind must be 1, 2 or 3/u);
  });

  it.each([
    ['publishMetadata', []],
    ['setMetadata', [3n, utf8('Evil Dollar'), utf8('EVL')]],
    ['withdrawMetadata', [1n]],
    ['mintShielded', [coinPublicKey(new Uint8Array(32).fill(0xcc)), 1n, new Uint8Array(32).fill(0xee)]],
    ['mintUnshielded', [HOLDER_USER_ADDRESS, 1n]],
    ['mintLedger', [account(new Uint8Array(32).fill(0xcc)), 1n]],
  ] as [string, unknown[]][])('a non-owner cannot call %s (Ownable assertion; nothing emitted)', async (circuit, args) => {
    const sim = await deploy();
    await expect(callAs(sim, STRANGER, circuit, ...args)).rejects.toThrow(/Ownable: caller is not the owner/u);
    const ok = await callAs(sim, OWNER, circuit, ...args);
    expect(ok.misc).toHaveLength(circuit === 'publishMetadata' ? 3 : circuit.startsWith('mint') ? 0 : 1);
  });

  it('the diff adds exactly the circuits publishMetadata, setMetadata and withdrawMetadata', () => {
    const without = deployedCircuits(managed['without-metadata']);
    const withMeta = deployedCircuits(managed['with-metadata']);
    expect(withMeta.filter((c) => !without.includes(c))).toEqual(['publishMetadata', 'setMetadata', 'withdrawMetadata']);
    expect(without.filter((c) => !withMeta.includes(c))).toEqual([]);
  });
});
