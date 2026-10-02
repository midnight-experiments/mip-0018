// SPDX-License-Identifier: Apache-2.0
//
// Network profiles.
//
//   stagenet    public endpoints and genesis pinned in toolchain.json (a unit test keeps these constants equal to it);
//               URLs may be overridden (e.g. a mirror) but the genesis check always uses the pinned hash.
//   undeployed  a local chain (docker/local-stack). EVERY URL is required — there is no default and never a fallback
//               to Stagenet; URLs of known public networks are refused, and so is a node whose genesis is Stagenet's.
//
// Identity check (before any submission, and by every wallet-free command): RPC `chain_getBlockHash(0)` must equal
// the profile's genesis (pinned for Stagenet; recorded in the run record, or given with --genesis, for undeployed).

import { HttpClient } from './http.ts';
import { normHex } from './hex.ts';

export type ProfileId = 'stagenet' | 'undeployed';

export interface NetworkProfile {
  id: ProfileId;
  /** Ledger network id used by midnight-js and the wallet. */
  networkId: string;
  indexer: string;
  indexerWs: string;
  rpc: string;
  rpcWs: string;
  /** Expected `chain_getBlockHash(0)`, `0x`-prefixed lowercase. Undefined only for a fresh undeployed chain. */
  genesisHash?: string;
  /** Public shared endpoints: requests are rate-bounded. */
  public: boolean;
  /** Minimum milliseconds between two requests to one endpoint. */
  minIntervalMs: number;
}

export const STAGENET = {
  networkId: 'stagenet',
  genesisHash: '0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491',
  indexer: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
  indexerWs: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
  rpc: 'https://rpc.stagenet.shielded.tools',
  rpcWs: 'wss://rpc.stagenet.shielded.tools',
} as const;

/** Hosts of public networks an `undeployed` profile must never reach. */
export const PUBLIC_HOST_SUFFIXES = ['shielded.tools', 'midnight.network', 'midnight.foundation'] as const;

/** Default politeness bound for public endpoints: at most 4 requests per second per endpoint. */
export const PUBLIC_MIN_INTERVAL_MS = 250;

export class ProfileError extends Error {
  override name = 'ProfileError';
}

export class IdentityError extends Error {
  override name = 'IdentityError';
}

export interface EndpointOverrides {
  indexer?: string;
  indexerWs?: string;
  rpc?: string;
  rpcWs?: string;
  genesisHash?: string;
  minIntervalMs?: number;
}

const toWs = (url: string): string => url.replace(/^http(s?):/u, 'ws$1:');

function checkUrl(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ProfileError(`${what} is not a URL: ${url}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new ProfileError(`${what} must be http(s) or ws(s): ${url}`);
  return url.replace(/\/+$/u, '');
}

export function isPublicHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return PUBLIC_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export function stagenetProfile(o: EndpointOverrides = {}): NetworkProfile {
  if (o.genesisHash !== undefined && normGenesis(o.genesisHash) !== STAGENET.genesisHash) {
    throw new ProfileError('the Stagenet genesis hash is pinned and cannot be overridden');
  }
  const indexer = checkUrl(o.indexer ?? STAGENET.indexer, 'indexer URL');
  const rpc = checkUrl(o.rpc ?? STAGENET.rpc, 'node RPC URL');
  return {
    id: 'stagenet',
    networkId: STAGENET.networkId,
    indexer,
    indexerWs: checkUrl(o.indexerWs ?? (o.indexer ? `${toWs(indexer)}/ws` : STAGENET.indexerWs), 'indexer WebSocket URL'),
    rpc,
    rpcWs: checkUrl(o.rpcWs ?? (o.rpc ? toWs(rpc) : STAGENET.rpcWs), 'node WebSocket URL'),
    genesisHash: STAGENET.genesisHash,
    public: true,
    minIntervalMs: o.minIntervalMs ?? PUBLIC_MIN_INTERVAL_MS,
  };
}

export function undeployedProfile(o: EndpointOverrides): NetworkProfile {
  if (!o.indexer) throw new ProfileError('undeployed: the indexer URL is required (--indexer or MIP0018_INDEXER_URL); there is no default');
  if (!o.rpc) throw new ProfileError('undeployed: the node RPC URL is required (--rpc or MIP0018_NODE_URL); there is no default');
  const indexer = checkUrl(o.indexer, 'indexer URL');
  const rpc = checkUrl(o.rpc, 'node RPC URL');
  const p: NetworkProfile = {
    id: 'undeployed',
    networkId: 'undeployed',
    indexer,
    indexerWs: checkUrl(o.indexerWs ?? `${toWs(indexer)}/ws`, 'indexer WebSocket URL'),
    rpc,
    rpcWs: checkUrl(o.rpcWs ?? toWs(rpc), 'node WebSocket URL'),
    public: false,
    minIntervalMs: o.minIntervalMs ?? 0,
  };
  if (o.genesisHash !== undefined) p.genesisHash = normGenesis(o.genesisHash);
  for (const [what, url] of [
    ['indexer', p.indexer],
    ['indexer WebSocket', p.indexerWs],
    ['node RPC', p.rpc],
    ['node WebSocket', p.rpcWs],
  ] as const) {
    if (isPublicHost(url)) throw new ProfileError(`undeployed: the ${what} URL ${url} belongs to a public network; refusing`);
  }
  return p;
}

/** Reads the profile from CLI flags, falling back to the environment ONLY for undeployed URLs. */
export function resolveProfile(
  id: string,
  flags: EndpointOverrides = {},
  env: Record<string, string | undefined> = process.env,
): NetworkProfile {
  if (id === 'stagenet') return stagenetProfile(flags);
  if (id === 'undeployed' || id === 'local') {
    const o: EndpointOverrides = {
      ...flags,
      indexer: flags.indexer ?? env.MIP0018_INDEXER_URL,
      indexerWs: flags.indexerWs ?? env.MIP0018_INDEXER_WS_URL,
      rpc: flags.rpc ?? env.MIP0018_NODE_URL,
      rpcWs: flags.rpcWs ?? env.MIP0018_NODE_WS_URL,
      genesisHash: flags.genesisHash ?? env.MIP0018_GENESIS_HASH,
    };
    return undeployedProfile(o);
  }
  throw new ProfileError(`unknown network "${id}" (expected stagenet or undeployed)`);
}

export function normGenesis(hash: string): string {
  return `0x${normHex(hash, 'genesis hash')}`;
}

/**
 * Reads the node's genesis hash and checks it against the profile. For an undeployed profile without a pinned
 * genesis it only refuses Stagenet's genesis. Returns the observed genesis.
 */
export async function checkIdentity(profile: NetworkProfile, http?: HttpClient): Promise<string> {
  const client = http ?? new HttpClient({ minIntervalMs: profile.minIntervalMs });
  const body = await client.postJson<{ result?: string | null; error?: unknown }>(profile.rpc, {
    id: 1,
    jsonrpc: '2.0',
    method: 'chain_getBlockHash',
    params: [0],
  });
  if (typeof body.result !== 'string')
    throw new IdentityError(`node ${profile.rpc} did not return a genesis hash: ${JSON.stringify(body)}`);
  const genesis = normGenesis(body.result);
  if (profile.genesisHash !== undefined && genesis !== profile.genesisHash) {
    throw new IdentityError(`wrong chain: node genesis ${genesis}, expected ${profile.genesisHash} (${profile.id})`);
  }
  if (profile.id === 'undeployed' && genesis === STAGENET.genesisHash) {
    throw new IdentityError('undeployed profile points at a node with the Stagenet genesis; refusing');
  }
  return genesis;
}
