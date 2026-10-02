// SPDX-License-Identifier: Apache-2.0
//
// Contract adapters: the per-contract knowledge the generic deploy/publish path cannot guess.
//
// A contract without witnesses and without constructor arguments needs no adapter (`--contract <managed dir>`).
// Anything else — witnesses (e.g. OpenZeppelin `Ownable`'s `wit_OwnableSK`), a private state holding the owner
// secret, constructor arguments derived from that secret, or how `--metadata` maps onto constructor/publish
// arguments for `deploy-and-publish` — is described by a module exporting `adapter` (or a default export):
//
//   examples/<name>/mip0018.adapter.ts      found by `--example <name>`
//   --adapter <file>                        any path
//
// Secrets an adapter creates (initialPrivateState) are stored only in the signer's 0600 private-state file under
// the contract address, BEFORE the deploy is submitted, and are never written to the public run record.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface MetadataInput {
  domainSep: string;
  kind: number;
  name?: string;
  symbol?: string;
  decimals?: number | string;
  standards?: string | string[];
  [extra: string]: unknown;
}

export interface AdapterContext<PS> {
  /** The private state the adapter created at deploy time (undefined for contracts without one). */
  privateState?: PS;
  /** The signer wallet's coin public key (hex). */
  coinPublicKey: string;
  /** `deploy-and-publish --metadata` (parsed), when given. */
  metadata?: MetadataInput;
  /** The deployed contract (calls only). */
  contractAddress?: string;
}

export interface ContractAdapter<PS = unknown> {
  /** compactc output: `managedDir` is relative to the adapter file. */
  contract: { name: string; managedDir: string };
  /** How to (re)compile when `managed/` is missing: an npm workspace script. */
  compile?: { workspace: string; script: string };
  witnesses?: Record<string, unknown>;
  privateStateId?: string;
  /** Creates the private state (e.g. a fresh owner secret). Called once per deploy. */
  initialPrivateState?: () => PS;
  /** Constructor arguments (runtime values) from the `--args` JSON and the context. */
  constructorArgs?: (json: unknown[], ctx: AdapterContext<PS>) => unknown[];
  /** Circuit arguments (runtime values); default: typed conversion from contract-info.json. */
  circuitArgs?: (circuit: string, json: unknown[], ctx: AdapterContext<PS>) => unknown[] | undefined;
  /** deploy-and-publish: the publish calls (circuit + JSON args) for the metadata. */
  publish?: (metadata: MetadataInput | undefined, ctx: AdapterContext<PS>) => { circuit: string; args: unknown[] }[];
  /** deploy-and-publish: the constructor JSON args for the metadata. */
  deployArgs?: (metadata: MetadataInput | undefined) => unknown[];
}

export interface LoadedAdapter {
  adapter: ContractAdapter;
  /** Absolute path of the adapter module. */
  path: string;
  /** Absolute managed dir. */
  managedDir: string;
}

export class AdapterError extends Error {
  override name = 'AdapterError';
}

export async function loadAdapter(path: string): Promise<LoadedAdapter> {
  const abs = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(abs)) throw new AdapterError(`adapter ${abs} does not exist`);
  const mod = (await import(pathToFileURL(abs).href)) as { adapter?: ContractAdapter; default?: ContractAdapter };
  const adapter = mod.adapter ?? mod.default;
  if (!adapter?.contract?.name || !adapter.contract.managedDir)
    throw new AdapterError(`${abs} exports no adapter with contract { name, managedDir }`);
  return { adapter, path: abs, managedDir: resolve(dirname(abs), adapter.contract.managedDir) };
}

/** Finds `mip0018.adapter.ts` for `--example <name>` under examples/, examples/openzeppelin/ or test-contracts/. */
export function exampleAdapterPath(repoRoot: string, example: string): string {
  const candidates =
    isAbsolute(example) || example.includes('/')
      ? [resolve(example)]
      : [
          join(repoRoot, 'examples', example),
          join(repoRoot, 'examples', 'openzeppelin', example),
          join(repoRoot, 'test-contracts', example),
        ];
  for (const dir of candidates) {
    const p = join(dir, 'mip0018.adapter.ts');
    if (existsSync(p)) return p;
  }
  throw new AdapterError(`no mip0018.adapter.ts for example "${example}" (looked in ${candidates.join(', ')})`);
}
