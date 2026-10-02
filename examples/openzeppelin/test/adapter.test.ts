// SPDX-License-Identifier: Apache-2.0
//
// The mip0018 CLI adapters of the OpenZeppelin examples, without a chain: the constructor arguments, witnesses,
// private state and call arguments the CLI derives from each adapter (placeholders resolved as a signer would, typed
// conversion from contract-info.json) deploy the example in compact-runtime and emit exactly the payloads the adapter
// tells `verify` to expect; the lifecycle calls reach metadata.json's expected consumer states; another signer's
// private state is not the owner; --metadata that the contract cannot emit is refused.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHex } from '@mip0018/codec';
import { compareState, expectedPayload, projectState } from '@mip0018/midnight';
import { circuitArgs, loadAdapter, resolvePlaceholders, type ContractAdapter, type PublishCall } from '@mip0018/midnight/signer';
import { lifecycleCalls, metadataOf, type OwnerState } from '../src/adapter.ts';
import { compileExample, EXAMPLE_NAMES, exampleDir, type ExampleName } from '../src/examples.ts';
import { Chain, Simulator, exampleAddress } from '../src/testing.ts';

const rnd = () => toHex(Uint8Array.from(randomBytes(32)));

async function setUp(example: ExampleName) {
  const loaded = await loadAdapter(join(exampleDir(example), 'mip0018.adapter.ts'));
  const adapter = loaded.adapter as ContractAdapter<OwnerState>;
  const managed = compileExample(example);
  expect(loaded.managedDir).toBe(managed);
  const signer = { coinPublicKey: rnd(), unshieldedAddress: rnd() };
  const privateState = adapter.initialPrivateState!();
  const ctx = { privateState, ...signer };
  const json = resolvePlaceholders(adapter.deployArgs!(undefined), { ...signer, adapter: adapter.values!(ctx) }) as unknown[];
  const address = exampleAddress(`adapter:${example}`);
  const sim = await Simulator.deploy<OwnerState>(managed, {
    witnesses: adapter.witnesses,
    privateState,
    args: adapter.constructorArgs!(json, ctx),
    address,
  });
  const call = async (c: PublishCall, as: OwnerState = privateState) => {
    sim.currentPrivateState = as;
    const j = resolvePlaceholders(c.args, { ...signer, adapter: adapter.values!({ ...ctx, privateState: as }) }) as unknown[];
    return sim.call(c.circuit, ...circuitArgs(managed, c.circuit, j));
  };
  return { adapter, managed, sim, call, privateState, address, ctx };
}

const payloadsOf = (c: PublishCall) => (c.expect ?? []).map((e) => (e.payload !== undefined ? e.payload : expectedPayload(e.metadata!)));

describe.each(EXAMPLE_NAMES)('mip0018 adapter: %s', (example) => {
  it('deploys with the adapter and its calls emit exactly what deploy-and-publish will verify', async () => {
    const { adapter, call, address } = await setUp(example);
    const chain = new Chain();
    const calls = adapter.publish!(undefined, { coinPublicKey: rnd() });
    expect(calls.map((c) => c.stepId)).toEqual(metadataOf(example).steps.map((s) => s.id));
    for (const c of calls) {
      const out = await call(c);
      expect(out.misc.map((m) => toHex(m.payload))).toEqual(payloadsOf(c));
      expect(out.misc.every((m) => m.address === address)).toBe(true);
      chain.apply(out);
    }
    expect(compareState(projectState(chain.state.identities(), chain.state.groups()), metadataOf(example).expected)).toEqual({
      ok: true,
      differences: [],
    });
  });

  it('the lifecycle calls (rename, withdraw, revive …) reach every expected state of metadata.json', async () => {
    const { adapter, call } = await setUp(example);
    const chain = new Chain();
    for (const c of adapter.publish!(undefined, { coinPublicKey: rnd() })) chain.apply(await call(c));
    const life = metadataOf(example).lifecycle;
    const calls = lifecycleCalls(example);
    expect(calls).toHaveLength(life.length);
    for (const [i, c] of calls.entries()) {
      const out = await call(c);
      expect(out.misc.map((m) => toHex(m.payload))).toEqual(payloadsOf(c));
      chain.apply(out);
      const want = life[i]!.expected!;
      expect(compareState(projectState(chain.state.identities(), chain.state.groups()), want).differences).toEqual([]);
    }
  });

  it("another signer's private state is not the owner: the publish fails before anything is emitted", async () => {
    const { adapter, call } = await setUp(example);
    const publish = adapter.publish!(undefined, { coinPublicKey: rnd() }).find((c) => c.circuit === 'publishMetadata')!;
    await expect(call(publish, adapter.initialPrivateState!())).rejects.toThrow(/caller is not the owner/);
  });

  it('refuses --metadata the contract cannot emit; accepts a restatement of its own', () => {
    return setUp(example).then(({ adapter }) => {
      const own = metadataOf(example).identities[0]!;
      expect(() => adapter.deployArgs!({ ...own })).not.toThrow();
      expect(() => adapter.deployArgs!({ ...own, name: 'Something Else' })).toThrow(/compiled into its contract/);
      expect(() => adapter.publish!({ ...own, decimals: 18 }, { coinPublicKey: rnd() })).toThrow(/compiled/);
      expect(() => adapter.publish!({ ...own, domainSep: `0x${'ee'.repeat(32)}` }, { coinPublicKey: rnd() })).toThrow(/compiled/);
    });
  });
});
