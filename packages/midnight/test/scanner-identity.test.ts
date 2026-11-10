// SPDX-License-Identifier: Apache-2.0
//
// The mint scanner's state records the chain instance (block 1) of the network it scans, and a resume is refused on
// another instance of the same genesis (a re-created network) before any block is read; a state that records no
// chain instance is resumed only on a chain that has its last scanned block at that height. Against a local node + indexer
// stub that counts every request (the stub's block at height h has hash 0x00…h).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.ts';
import { undeployedProfile } from '../src/network.ts';
import { newState, saveState, scan, statePath } from '../src/scanner.ts';
import { chainStub, type ChainStub } from './support/chain-stub.ts';

const G = `0x${'12'.repeat(32)}`;
const C1 = `0x${'c1'.repeat(32)}`;
const C2 = `0x${'c2'.repeat(32)}`;

const tmp = mkdtempSync(join(tmpdir(), 'mip0018-scan-identity-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const stubs: ChainStub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});
const profileAt = (s: ChainStub) => undeployedProfile({ rpc: s.rpc, indexer: s.indexer });

describe('scanner state and the chain instance', () => {
  it('a new state records block 1 of the node it scans', async () => {
    const s = await chainStub({ genesis: G, blockOne: C1 });
    stubs.push(s);
    const dir = join(tmp, 'new');
    const r = await scan({ profile: profileAt(s), stateDir: dir, fromHeight: 200, poll: true, http: new HttpClient({ attempts: 1 }) });
    expect(r.state.network).toMatchObject({ id: 'undeployed', genesisHash: G, chainInstance: C1 });
    expect(r.mode).toBe('none');
  });

  it('resuming on another instance of the same genesis is refused before any indexer read; the state is unchanged', async () => {
    const s = await chainStub({ genesis: G, blockOne: C2 });
    stubs.push(s);
    const dir = join(tmp, 'resume');
    const p = profileAt(s);
    saveState(dir, newState(p, G, 5, C1));
    const before = readFileSync(statePath(dir), 'utf8');
    const err = await scan({
      profile: p,
      stateDir: dir,
      fromHeight: 5,
      toHeight: 6,
      poll: true,
      http: new HttpClient({ attempts: 1 }),
    }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/another instance of undeployed: node block 1 is 0xc2c2.*expected 0xc1c1/u);
    expect(s.counts.indexer).toBe(0);
    expect(readFileSync(statePath(dir), 'utf8')).toBe(before);
  });

  it('a state that records no chain instance: refused unless the node has its last scanned block; then it takes block 1', async () => {
    const s = await chainStub({ genesis: G, blockOne: C1 });
    stubs.push(s);
    const p = profileAt(s);
    const legacy = (dir: string, lastHash: string) => {
      const st = newState(p, G, 5);
      st.nextHeight = 8;
      st.lastBlock = { height: 7, hash: lastHash };
      saveState(dir, st);
      return dir;
    };
    const other = legacy(join(tmp, 'legacy-other'), 'ff'.repeat(32));
    const before = readFileSync(statePath(other), 'utf8');
    const err = await scan({
      profile: p,
      stateDir: other,
      fromHeight: 5,
      toHeight: 7,
      poll: true,
      http: new HttpClient({ attempts: 1 }),
    }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/records no chain instance and its last scanned block 7 is ffff.*another chain/u);
    expect(s.counts.indexer).toBe(0);
    expect(readFileSync(statePath(other), 'utf8')).toBe(before);
    const same = legacy(join(tmp, 'legacy-same'), (7).toString(16).padStart(64, '0'));
    const r = await scan({ profile: p, stateDir: same, fromHeight: 5, toHeight: 7, poll: true, http: new HttpClient({ attempts: 1 }) });
    expect(r.mode).toBe('none');
    expect(r.state.network.chainInstance).toBe(C1);
  });
});
