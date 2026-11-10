// SPDX-License-Identifier: Apache-2.0
//
// A wallet starts only on the chain its profile names: `openWallet` checks the node's identity before it reads or
// connects anything, so every caller (the CLI, the example scripts, the local test wallets) is covered. Against a
// local node + indexer stub that counts every request and WebSocket upgrade.

import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_NETWORKS, undeployedProfile, type NetworkProfile } from '../src/network.ts';
import { closeWallet, GENESIS_DEV_SEED_HEX, openWallet, type WalletSession } from '../src/signer/index.ts';
import { chainStub, type ChainStub } from './support/chain-stub.ts';

const G = `0x${'12'.repeat(32)}`;
const C1 = `0x${'c1'.repeat(32)}`;
const C2 = `0x${'c2'.repeat(32)}`;

const stubs: ChainStub[] = [];
const sessions: WalletSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await closeWallet(s).catch(() => {});
  for (const s of stubs.splice(0)) await s.close();
});
const seed = () => Uint8Array.from(Buffer.from(GENESIS_DEV_SEED_HEX, 'hex'));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** openWallet's outcome: the error it refused with, or the session it opened (closed after the test). */
async function open(profile: NetworkProfile, key = seed()): Promise<Error | WalletSession> {
  try {
    const s = await openWallet({ profile, proofServer: 'http://127.0.0.1:9' }, key);
    sessions.push(s);
    return s;
  } catch (e) {
    return e as Error;
  }
}

describe('openWallet checks the network identity before the wallet connects', () => {
  it('undeployed at a node with a public genesis: refused, the wallet never connects', async () => {
    const s = await chainStub({ genesis: PUBLIC_NETWORKS.preview.genesisHash, blockOne: C1 });
    stubs.push(s);
    const key = seed();
    const r = await open(undeployedProfile({ rpc: s.rpc, indexer: s.indexer }), key);
    await pause(2_000);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/the undeployed profile points at a node with the preview genesis/u);
    expect(key.every((b) => b === 0)).toBe(true);
    expect(s.counts.indexer + s.counts.upgrades).toBe(0);
  });

  it('a profile with a chain instance at a node with another block 1: refused, the wallet never connects', async () => {
    const s = await chainStub({ genesis: G, blockOne: C2 });
    stubs.push(s);
    const r = await open(undeployedProfile({ rpc: s.rpc, indexer: s.indexer, genesisHash: G, chainInstance: C1 }));
    await pause(2_000);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/another instance of undeployed: node block 1 is 0xc2c2.*expected 0xc1c1/u);
    expect(s.counts.indexer + s.counts.upgrades).toBe(0);
  });

  it('the chain the profile names: the wallet opens and connects', async () => {
    const s = await chainStub({ genesis: G, blockOne: C1 });
    stubs.push(s);
    const r = await open(undeployedProfile({ rpc: s.rpc, indexer: s.indexer, genesisHash: G, chainInstance: C1 }));
    expect(r).not.toBeInstanceOf(Error);
    for (let i = 0; i < 50 && s.counts.indexer + s.counts.upgrades === 0; i++) await pause(200);
    expect(s.counts.indexer + s.counts.upgrades).toBeGreaterThan(0);
  });
});
