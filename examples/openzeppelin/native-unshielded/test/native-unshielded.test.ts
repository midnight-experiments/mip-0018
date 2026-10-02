// SPDX-License-Identifier: Apache-2.0
//
// examples/openzeppelin/native-unshielded in compact-runtime 0.20.0 (no chain):
//   * publishMetadata() emits exactly the metadata.json payload: kind 2, `domainSep` read from
//     `_domain`, the same literals the constructor stored;
//   * the color: `rawTokenType(domainSep, contractAddress)` (official runtime) equals the color
//     `mintUnshieldedToken` returns, the color of the UTXO the mint creates for the holder (claimed
//     unshielded spend), `tokenColor()` and the color the reference consumer derives for the kind-2
//     identity; the unshielded mint effect is keyed by the event's `domainSep`;
//   * rename, withdraw, repeated withdraw and revive: bytes and consumer state equal metadata.json;
//   * mint emits nothing; Ownable guards every emitting circuit.

import { decodePayload, decodeUtf8, fromHex, toHex } from '@mip0018/codec';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileExample, type Variant } from '../../src/examples.ts';
import { expectStepEvents, sortedState } from '../../src/expect.ts';
import {
  account,
  accountId,
  callAs,
  Chain,
  colorOf,
  deployAs,
  deployedCircuits,
  encodeExpected,
  exampleAddress,
  loadMetadata,
  mintsOf,
  userAddress,
  utf8,
  type OzPrivateState,
  type Simulator,
  type Step,
} from '../../src/testing.ts';

const META = loadMetadata('native-unshielded');
const CTOR = META.contract.constructorArgs as { domainSep: string; name_: string; symbol_: string; decimals_: number };
const DOMAIN = fromHex(CTOR.domainSep);
const OWNER = new Uint8Array(32).fill(0x0a);
const STRANGER = new Uint8Array(32).fill(0x0c);
const HOLDER = new Uint8Array(32).fill(0xb2); // the holder's unshielded user address
const ADDRESS = exampleAddress('native-unshielded');
const COLOR = colorOf(DOMAIN, ADDRESS);

const managed = {} as Record<Variant, string>;
beforeAll(() => {
  managed['with-metadata'] = compileExample('native-unshielded');
  managed['without-metadata'] = compileExample('native-unshielded', { variant: 'without-metadata' });
}, 300_000);

const deploy = (variant: Variant = 'with-metadata'): Promise<Simulator<OzPrivateState>> =>
  deployAs(managed[variant], OWNER, [DOMAIN, CTOR.name_, CTOR.symbol_, BigInt(CTOR.decimals_), account(accountId(OWNER))], ADDRESS);

/** The circuit arguments of a metadata.json step. */
const argsOf = (step: Step): unknown[] => {
  if (step.circuit === 'setMetadata') return [utf8(step.args.newName as string), utf8(step.args.newSymbol as string)];
  if (step.circuit === 'mint') return [{ bytes: HOLDER }, BigInt(step.args.amount as string)];
  return [];
};

describe('metadata.json', () => {
  it('every payload equals the reference encoder', () => {
    for (const step of [...META.steps, ...META.lifecycle])
      for (const e of step.events) expect(e.payload, step.id).toBe(toHex(encodeExpected(e)));
  });

  it('publishes the domainSep and the literals the constructor stores', () => {
    expect(META.identities).toEqual([
      { domainSep: CTOR.domainSep, kind: 2, name: CTOR.name_, symbol: CTOR.symbol_, decimals: CTOR.decimals_ },
    ]);
  });
});

describe('MyUnshieldedToken (std-lib mintUnshieldedToken + OpenZeppelin Ownable + MIP-0018)', () => {
  it('publishMetadata() emits the metadata.json payload: kind 2, domainSep = _domain', async () => {
    const sim = await deploy();
    const out = await callAs(sim, OWNER, 'publishMetadata');
    expectStepEvents(
      out,
      META.steps.find((s) => s.id === 'publish')!,
      ADDRESS,
    );
    const decoded = decodePayload(out.misc[0]!.payload);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(toHex(decoded.header.domainSep)).toBe(toHex(DOMAIN));
    expect(decoded.header.kind).toBe(2);
    expect(decoded.records.map((r) => (r.valType === 1 ? decodeUtf8(r.value) : r.value[0]))).toEqual([
      CTOR.name_,
      CTOR.symbol_,
      CTOR.decimals_,
    ]);
    // The contract's own state holds the same values the event carries (read here, off chain).
    const ledger = sim.ledger<{ _domain: Uint8Array; _decimals: bigint }>();
    expect(toHex(ledger._domain)).toBe(toHex(DOMAIN));
    expect(ledger._decimals).toBe(BigInt(CTOR.decimals_));
  });

  it('the minted UTXO has the color rawTokenType(domainSep, contractAddress), which the consumer derives from the event', async () => {
    const sim = await deploy();
    const minted = await callAs<Uint8Array>(sim, OWNER, 'mint', { bytes: HOLDER }, 1_000n);
    expect(minted.events).toHaveLength(0);
    // The color mintUnshieldedToken returns, and the UTXO the transaction must create for the holder.
    expect(toHex(minted.result)).toBe(COLOR);
    const m = mintsOf(minted);
    expect(m.unshieldedOutputs).toEqual([{ color: COLOR, amount: 1_000n, tag: 'unshielded' }]);
    // The mint effect a scanner reads: keyed by the domainSep, which is the event's domainSep.
    expect(m.unshieldedMints).toEqual(new Map([[toHex(DOMAIN), 1_000n]]));
    expect([m.shieldedMints.size, m.shieldedOutputs.length]).toEqual([0, 0]);
    expect(toHex((await callAs<Uint8Array>(sim, OWNER, 'tokenColor')).result)).toBe(COLOR);
    const chain = new Chain();
    chain.apply(await callAs(sim, OWNER, 'publishMetadata'));
    const view = chain.identity(ADDRESS, CTOR.domainSep, 2)!;
    expect(view.colored).toBe(true);
    expect(toHex(view.color!)).toBe(COLOR);
    expect(view.domainSep).toBe([...m.unshieldedMints.keys()][0]);
  });

  it('mint → publish (steps), then rename → withdraw → withdraw again → revive: bytes, mints and consumer state equal metadata.json', async () => {
    const sim = await deploy();
    const chain = new Chain();
    for (const step of [...META.steps, ...META.lifecycle]) {
      const out = await callAs(sim, OWNER, step.circuit, ...argsOf(step));
      expectStepEvents(out, step, ADDRESS);
      const m = mintsOf(out);
      expect([...m.unshieldedMints].map(([d, a]) => ({ kind: 2, domainSep: `0x${d}`, amount: a.toString() }))).toEqual(step.mints ?? []);
      chain.apply(out);
      if (step.expected || META.steps.at(-1) === step)
        expect(sortedState(chain.snapshot(ADDRESS)), step.id).toEqual(sortedState(step.expected ?? META.expected));
    }
  });

  it.each(['with-metadata', 'without-metadata'] as Variant[])('mint emits no event (normal operation) — %s', async (variant) => {
    const sim = await deploy(variant);
    for (let i = 0; i < 3; i++) expect((await callAs(sim, OWNER, 'mint', { bytes: HOLDER }, 10n)).events).toHaveLength(0);
  });

  it.each([
    ['publishMetadata', []],
    ['setMetadata', [utf8('Evil Public'), utf8('EVIL')]],
    ['withdrawMetadata', []],
    ['mint', [userAddress(HOLDER).right, 1n]],
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
