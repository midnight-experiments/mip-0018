// SPDX-License-Identifier: Apache-2.0
//
// The identity sources of the files a command acts on, collected in one place (`identitySources`): each file's own
// recorded network (a run record's or a scanner state's `network`, a network file's) and the network file of the case
// folder it lies in (`deployments/<network>/network.json` holds the identity — genesis, chain instance — of the network
// the cases in `deployments/<network>/cases/<ID>/` ran on). A command binds its profile to all of them
// (`profileForFiles`) before its first read or transaction, or, without a network, checks that they agree; a network
// re-created from the same genesis is then refused before anything is read. A caller passes the paths of its
// arguments, never a network it read itself, so no source can be left out.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  agreeRecordedNetworks,
  bindRecordedNetworks,
  ProfileError,
  type NetworkProfile,
  type RecordedNetwork,
  type RecordedSource,
} from './network.ts';

/** The scanner state file of a state directory. */
const STATE_FILE = 'index-state.json';

/** The network file of the case folder `path` lies in (`<dir>/cases/<ID>/…` → `<dir>/network.json`), if it exists. */
export function caseNetworkFile(path: string): string | undefined {
  const abs = resolve(path);
  let dir = existsSync(abs) && statSync(abs).isDirectory() ? abs : dirname(abs);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    if (basename(parent) === 'cases') {
      const file = join(dirname(parent), 'network.json');
      if (existsSync(file)) return file;
    }
    dir = parent;
  }
}

const networkOf = (file: string, n: { id?: unknown; genesisHash?: unknown; chainInstance?: unknown } | undefined): RecordedNetwork => {
  if (typeof n?.id !== 'string') throw new ProfileError(`${file} has no network.id`);
  return {
    id: n.id,
    ...(typeof n.genesisHash === 'string' ? { genesisHash: n.genesisHash } : {}),
    ...(typeof n.chainInstance === 'string' ? { chainInstance: n.chainInstance } : {}),
  };
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ProfileError(`${file}: ${(e as Error).message}`);
  }
};

/** The recorded network of a network file (its `network` object). */
export function readNetworkFile(file: string): RecordedNetwork {
  return networkOf(file, (readJson(file) as { network?: { id?: unknown } } | null)?.network);
}

/**
 * The network a file records: a run record, a scanner state (its directory or its `index-state.json`) or a network
 * file. Undefined for a path that does not exist yet (a new record) or a directory without a scanner state; any other
 * existing file is a `ProfileError`.
 */
export function recordedNetworkOf(path: string): RecordedSource | undefined {
  if (!existsSync(path)) return undefined;
  const file = statSync(path).isDirectory() ? join(path, STATE_FILE) : path;
  if (!existsSync(file)) return undefined;
  const j = readJson(file) as { kind?: unknown; network?: { id?: unknown }; observations?: unknown } | null;
  if (j?.kind === 'mip0018-run-record' || j?.kind === 'mip0018-index-state' || Array.isArray(j?.observations))
    return { source: file, network: networkOf(file, j?.network) };
  throw new ProfileError(`${file} is not a run record, a scanner state or a network file`);
}

/** Every identity source of the files at `paths`: each file's own network and its case folder's network file. */
export function identitySources(paths: readonly string[]): RecordedSource[] {
  const out: RecordedSource[] = [];
  const seen = new Set<string>();
  const add = (r: RecordedSource) => {
    const key = resolve(r.source);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  for (const p of paths) {
    const caseFile = caseNetworkFile(p);
    if (caseFile !== undefined) add({ source: caseFile, network: readNetworkFile(caseFile) });
    const own = recordedNetworkOf(p);
    if (own !== undefined) add(own);
  }
  return out;
}

/** The profile for a command acting on the files at `paths`: bound (`bindRecordedNetworks`) to every identity source. */
export function profileForFiles(profile: NetworkProfile, paths: readonly string[]): NetworkProfile {
  return bindRecordedNetworks(profile, identitySources(paths));
}

/** Checks that the files at `paths` record one chain (`agreeRecordedNetworks`), for a command that reads no network. */
export function agreeFiles(paths: readonly string[]): void {
  agreeRecordedNetworks(identitySources(paths));
}
