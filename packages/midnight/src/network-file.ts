// SPDX-License-Identifier: Apache-2.0
//
// The network file of a case folder: `deployments/<network>/network.json` holds the identity (genesis, chain instance)
// of the network the cases in `deployments/<network>/cases/<ID>/` ran on. A command that reads or writes a file inside
// such a folder (a run record, a scanner state, the case folder itself) binds its profile to that identity too, so
// a network re-created from the same genesis is refused before the first read or transaction.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { bindRecordedNetworks, ProfileError, type NetworkProfile, type RecordedNetwork, type RecordedSource } from './network.ts';

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

/** The recorded network of a network file (its `network` object). */
export function readNetworkFile(file: string): RecordedNetwork {
  let n: { id?: unknown; genesisHash?: unknown; chainInstance?: unknown } | undefined;
  try {
    n = (JSON.parse(readFileSync(file, 'utf8')) as { network?: typeof n }).network;
  } catch (e) {
    throw new ProfileError(`${file}: ${(e as Error).message}`);
  }
  if (typeof n?.id !== 'string') throw new ProfileError(`${file} has no network.id`);
  return {
    id: n.id,
    ...(typeof n.genesisHash === 'string' ? { genesisHash: n.genesisHash } : {}),
    ...(typeof n.chainInstance === 'string' ? { chainInstance: n.chainInstance } : {}),
  };
}

/**
 * The profile for a command acting on files: bound (`bindRecordedNetworks`) to the network file of the case folder
 * each path lies in, and to the networks the files themselves recorded.
 */
export function profileForFiles(
  profile: NetworkProfile,
  paths: readonly string[],
  recorded: readonly RecordedSource[] = [],
): NetworkProfile {
  const files = [...new Set(paths.map(caseNetworkFile).filter((f): f is string => f !== undefined))];
  return bindRecordedNetworks(profile, [...files.map((f) => ({ source: f, network: readNetworkFile(f) })), ...recorded]);
}
