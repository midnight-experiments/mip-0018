// SPDX-License-Identifier: Apache-2.0
//
// The raw emitter's mip0018 CLI adapter, without a chain: the CLI's deploy (owner = the deployer's fresh secret) and
// `publish --circuit emitRaw|emitTwo --args <[hex…]>` (typed conversion from contract-info.json) emit the vectors'
// bytes exactly; another signer's private state is not the owner.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHex } from '@mip0018/codec';
import { Simulator } from '@mip0018/compact/testing';
import { circuitArgs, loadAdapter, type ContractAdapter } from '@mip0018/midnight/signer';
import { compileRawEmitter, PACKAGE_DIR, type RawEmitterPrivateState } from '../src/contract.ts';

const REPO = join(PACKAGE_DIR, '..', '..');
const vec = (id: string) =>
  (JSON.parse(readFileSync(join(REPO, 'vectors', 'payload', `${id}.json`), 'utf8')) as { event: { name_hex: string; payload_hex: string } })
    .event;

describe('mip0018 adapter: raw emitter (test-only)', () => {
  it('deploys with the adapter and emits exactly the given vectors; a non-owner is refused', async () => {
    const loaded = await loadAdapter(join(PACKAGE_DIR, 'mip0018.adapter.ts'));
    const adapter = loaded.adapter as ContractAdapter<RawEmitterPrivateState>;
    const managed = compileRawEmitter();
    expect(loaded.managedDir).toBe(managed);
    const privateState = adapter.initialPrivateState!();
    const ctx = { privateState, coinPublicKey: '00'.repeat(32) };
    expect(() => adapter.constructorArgs!(['0x00'], ctx)).toThrow(/no constructor arguments/);
    const sim = await Simulator.deploy<RawEmitterPrivateState>(managed, {
      witnesses: adapter.witnesses,
      privateState,
      args: adapter.constructorArgs!(adapter.deployArgs!(undefined), ctx),
    });
    for (const id of ['R1', 'R2a', 'R5e', 'I1a']) {
      const v = vec(id);
      const out = await sim.call('emitRaw', ...circuitArgs(managed, 'emitRaw', [v.name_hex, v.payload_hex]));
      expect(out.misc.map((m) => [toHex(m.name), toHex(m.payload)])).toEqual([[v.name_hex, v.payload_hex]]);
    }
    const s7 = JSON.parse(readFileSync(join(REPO, 'vectors', 'state', 'S7b.json'), 'utf8')) as {
      steps: { name_hex: string; payload_hex: string }[];
    };
    const two = s7.steps.flatMap((s) => [s.name_hex, s.payload_hex]);
    const out = await sim.call('emitTwo', ...circuitArgs(managed, 'emitTwo', two));
    expect(out.misc.map((m) => toHex(m.payload))).toEqual(s7.steps.map((s) => s.payload_hex));
    sim.currentPrivateState = adapter.initialPrivateState!();
    await expect(sim.call('emitRaw', ...circuitArgs(managed, 'emitRaw', [vec('A1').name_hex, vec('A1').payload_hex]))).rejects.toThrow(
      /caller is not the owner/,
    );
  });
});
