// SPDX-License-Identifier: Apache-2.0
//
// The mip0018 CLI adapters of the minimal example, without a chain: what the CLI derives from each adapter (constructor
// arguments from metadata.json or --metadata, the secretKey witness and private state, call arguments converted with
// contract-info.json types) deploys the contract in compact-runtime and emits exactly the payload the adapter tells
// `verify` to expect; OwnerKey's lifecycle reaches every expected state of owner-key.metadata.json; another signer is
// not the owner; --metadata may choose the domainSep but nothing compiled in.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHex } from '@mip0018/codec';
import { MetadataState } from '@mip0018/consumer';
import { compareState, expectedPayload, projectState, tokenType } from '@mip0018/midnight';
import { circuitArgs, loadAdapter, resolvePlaceholders, type ContractAdapter, type PublishCall } from '@mip0018/midnight/signer';
import { Simulator, type CallOutcome } from '@mip0018/compact/testing';
import { lifecycleCalls, metadataOf } from '../src/adapter.ts';
import { CONTRACTS, EXAMPLE_DIR, compileMinimal, type MinimalContract, type MinimalPrivateState } from '../src/contracts.ts';

const FILES: Record<MinimalContract, string> = {
  CreateAndDestroy: 'mip0018.adapter.ts',
  OwnerKey: 'owner-key.mip0018.adapter.ts',
  PublishOnce: 'publish-once.mip0018.adapter.ts',
};
const rnd = () => toHex(Uint8Array.from(randomBytes(32)));
const ADDRESS = 'cd'.repeat(32);

async function setUp(contract: MinimalContract, metadata?: Parameters<NonNullable<ContractAdapter['deployArgs']>>[0]) {
  const loaded = await loadAdapter(join(EXAMPLE_DIR, FILES[contract]));
  const adapter = loaded.adapter as ContractAdapter<MinimalPrivateState>;
  const managed = compileMinimal(contract);
  expect(loaded.managedDir).toBe(managed);
  const signer = { coinPublicKey: rnd(), unshieldedAddress: rnd() };
  const privateState = adapter.initialPrivateState!();
  const ctx = { privateState, ...signer };
  const json = resolvePlaceholders(adapter.deployArgs!(metadata), { ...signer, adapter: adapter.values!(ctx) }) as unknown[];
  const sim = await Simulator.deploy<MinimalPrivateState>(managed, {
    witnesses: adapter.witnesses,
    privateState,
    args: adapter.constructorArgs!(json, ctx),
    address: ADDRESS,
  });
  const call = (c: PublishCall, as: MinimalPrivateState = privateState) => {
    sim.currentPrivateState = as;
    return sim.call(c.circuit, ...circuitArgs(managed, c.circuit, resolvePlaceholders(c.args, signer) as unknown[]));
  };
  return { adapter, call, metadata };
}

const payloadsOf = (c: PublishCall) => (c.expect ?? []).map((e) => (e.payload !== undefined ? e.payload : expectedPayload(e.metadata!)));
const stateOf = (outs: CallOutcome[]) => {
  const s = new MetadataState({ tokenType });
  outs.forEach((o, b) =>
    o.misc.forEach((m, event) =>
      s.apply({
        network: 'undeployed',
        contractAddress: Buffer.from(m.address, 'hex'),
        block: b + 1,
        tx: 0,
        event,
        type: 'Misc',
        name: m.name,
        payload: m.payload,
      }),
    ),
  );
  return projectState(s.identities(), s.groups());
};

describe.each(CONTRACTS)('mip0018 adapter: minimal %s', (contract) => {
  it('deploys with the adapter; publishMetadata emits exactly MIP Appendix A (A1) = metadata.json', async () => {
    const { adapter, call } = await setUp(contract);
    const calls = adapter.publish!(undefined, { coinPublicKey: rnd() });
    expect(calls).toHaveLength(1);
    const out = await call(calls[0]!);
    expect(out.misc.map((m) => toHex(m.payload))).toEqual(payloadsOf(calls[0]!));
    expect(out.misc.map((m) => toHex(m.payload))).toEqual(metadataOf(contract).steps[0]!.events.map((e) => e.payload));
    expect(compareState(stateOf([out]), metadataOf(contract).expected).differences).toEqual([]);
  });

  it('--metadata may choose the domainSep (a constructor argument) but nothing compiled in', async () => {
    const lit = metadataOf(contract).identities[0]!;
    const ds = `0x${'5a'.repeat(32)}`;
    const { adapter, call } = await setUp(contract, { ...lit, domainSep: ds });
    const c = adapter.publish!({ ...lit, domainSep: ds }, { coinPublicKey: rnd() })[0]!;
    const out = await call(c);
    expect(toHex(out.misc[0]!.payload).slice(0, 64)).toBe('5a'.repeat(32));
    expect(out.misc.map((m) => toHex(m.payload))).toEqual(payloadsOf(c));
    expect(() => adapter.deployArgs!({ ...lit, name: 'Other Name' })).toThrow(/compiled-in/);
    expect(() => adapter.deployArgs!({ ...lit, domainSep: '0x12' })).toThrow(/32 bytes/);
  });
});

describe('mip0018 adapter: minimal OwnerKey lifecycle', () => {
  it('rename, withdraw, withdraw again, revive reach every expected state; a non-owner is refused', async () => {
    const { adapter, call } = await setUp('OwnerKey');
    const outs = [await call(adapter.publish!(undefined, { coinPublicKey: rnd() })[0]!)];
    const life = metadataOf('OwnerKey').lifecycle;
    for (const [i, c] of lifecycleCalls('OwnerKey').entries()) {
      const out = await call(c);
      expect(out.misc.map((m) => toHex(m.payload))).toEqual(payloadsOf(c));
      outs.push(out);
      expect(compareState(stateOf(outs), life[i]!.expected!).differences).toEqual([]);
    }
    // the revive is a partial event: name and symbol only — decimals and standards do not come back (vector S3c)
    expect(life.at(-1)!.expected!.identities[0]!.common).toEqual({ name: 'Acme Again', symbol: 'ACMA' });
    await expect(call(lifecycleCalls('OwnerKey')[0]!, adapter.initialPrivateState!())).rejects.toThrow(/caller is not the owner/);
  });
});
