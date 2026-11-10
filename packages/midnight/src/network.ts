// SPDX-License-Identifier: Apache-2.0
//
// Network profiles.
//
//   preview     Midnight-hosted public endpoints; no token.
//   preprod     Blockfrost endpoints; every request carries the project token of a Midnight Preprod project as
//               `project_id`, read from MIP0018_BLOCKFROST_PREPROD or from a 0600 file (--blockfrost-token-file).
//   mainnet     Blockfrost endpoints; the same with a Midnight Mainnet project token (MIP0018_BLOCKFROST_MAINNET).
//   undeployed  a local chain (docker/local-stack). EVERY URL is required — there is no default; URLs of the public
//               networks are refused, and so is a node whose genesis is a public network's.
//
// The public profiles pin network id, genesis hash, endpoints and address prefixes (equal to toolchain.json
// `networks`; a unit test keeps them equal). Their URLs may be overridden (a mirror, a local stub), the genesis never.
//
// Tokens: a profile's URL fields never hold a token — they are what reports and records show. `connectUrl` adds
// `project_id` at the moment a client connects, and the token lives outside the profile object, so serialising a
// profile cannot reveal it. A preprod or mainnet profile is not built without its token: a command stops before its
// first request and names the variable it reads. Every URL written anywhere goes through `redactUrl` (redact.ts).
//
// Identity (before the first request that changes state or checks a case): `chain_getBlockHash(0)` must equal the
// profile's genesis, and `chain_getBlockHash(1)` its chain instance when one is known (a case's network.json, a run
// record, a scanner state, or --chain-instance): a network re-created from the same genesis has another block 1.
// `bindRecordedNetworks` is the one place a profile takes the identity a file recorded: every command that reads or
// writes on behalf of a recorded file binds its profile through it before its first request.

import { HttpClient } from './http.ts';
import { Indexer } from './indexer.ts';
import { normHexBytes } from './hex.ts';
import { readProtectedFile } from './protected-file.ts';
import { redactUrl, registerSecret, ScrubbedError, scrubSecrets, TOKEN_PARAM } from './redact.ts';
import { NodeRpc } from './rpc.ts';

export const PROFILE_IDS = ['undeployed', 'preview', 'preprod', 'mainnet'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
export type PublicNetworkId = Exclude<ProfileId, 'undeployed'>;

/** Bech32m prefixes of the addresses of a network (wallet SDK address format). */
export interface AddressPrefixes {
  unshielded: string;
  shielded: string;
  dust: string;
}

/** The pinned facts of a public network. */
export interface PublicNetwork {
  networkId: string;
  /** `system_chain` of its nodes. */
  chain: string;
  /** `chain_getBlockHash(0)`, `0x`-prefixed lowercase. */
  genesisHash: string;
  indexer: string;
  indexerWs: string;
  rpc: string;
  rpcWs: string;
  /** The environment variable holding the Blockfrost project token; absent = the endpoints take no token. */
  tokenVariable?: string;
  addressPrefixes: AddressPrefixes;
}

const prefixes = (networkId: string): AddressPrefixes => {
  const n = networkId === 'mainnet' ? '' : `_${networkId}`;
  return { unshielded: `mn_addr${n}`, shielded: `mn_shield-addr${n}`, dust: `mn_dust${n}` };
};

export const PUBLIC_NETWORKS: Readonly<Record<PublicNetworkId, PublicNetwork>> = {
  preview: {
    networkId: 'preview',
    chain: 'Midnight Preview',
    genesisHash: '0x3c096de209e06a1a8c52be7bda109ee8c891a42288c0a9db5495f9616dd13796',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    rpc: 'https://rpc.preview.midnight.network',
    rpcWs: 'wss://rpc.preview.midnight.network',
    addressPrefixes: prefixes('preview'),
  },
  preprod: {
    networkId: 'preprod',
    chain: 'Midnight Preprod',
    genesisHash: '0xdf831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b',
    indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    rpc: 'https://rpc.midnight-preprod.blockfrost.io',
    rpcWs: 'wss://rpc.midnight-preprod.blockfrost.io',
    tokenVariable: 'MIP0018_BLOCKFROST_PREPROD',
    addressPrefixes: prefixes('preprod'),
  },
  mainnet: {
    networkId: 'mainnet',
    chain: 'Midnight Mainnet',
    genesisHash: '0x1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854',
    indexer: 'https://midnight-mainnet.blockfrost.io/api/v0',
    indexerWs: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws',
    rpc: 'https://rpc.midnight-mainnet.blockfrost.io',
    rpcWs: 'wss://rpc.midnight-mainnet.blockfrost.io',
    tokenVariable: 'MIP0018_BLOCKFROST_MAINNET',
    addressPrefixes: prefixes('mainnet'),
  },
};

export const UNDEPLOYED_ADDRESS_PREFIXES: AddressPrefixes = prefixes('undeployed');

/** Hosts of the public networks' endpoints: an `undeployed` profile never reaches them. */
export const PUBLIC_HOST_SUFFIXES = ['midnight.network', 'blockfrost.io'] as const;

/** Default politeness bound for public endpoints: at most 4 requests per second per endpoint. */
export const PUBLIC_MIN_INTERVAL_MS = 250;

export interface NetworkProfile {
  id: ProfileId;
  /** Ledger network id used by midnight-js and the wallet. */
  networkId: string;
  /** Endpoint URLs as reports and records show them: never a query string, never a token. */
  indexer: string;
  indexerWs: string;
  rpc: string;
  rpcWs: string;
  /** Expected `chain_getBlockHash(0)`, `0x`-prefixed lowercase. Undefined only for a fresh undeployed chain. */
  genesisHash?: string;
  /** Expected `chain_getBlockHash(1)` (the chain instance), `0x`-prefixed lowercase, when known. */
  chainInstance?: string;
  addressPrefixes: AddressPrefixes;
  /** Where the Blockfrost project token came from (the variable or the file; never the token). */
  tokenSource?: string;
  /** Public shared endpoints: requests are rate-bounded. */
  public: boolean;
  /** Minimum milliseconds between two requests to one endpoint. */
  minIntervalMs: number;
}

export class ProfileError extends ScrubbedError {
  override name = 'ProfileError';
}

export class IdentityError extends ScrubbedError {
  override name = 'IdentityError';
}

export interface EndpointOverrides {
  indexer?: string;
  indexerWs?: string;
  rpc?: string;
  rpcWs?: string;
  genesisHash?: string;
  chainInstance?: string;
  minIntervalMs?: number;
  /** A 0600 file holding the Blockfrost project token (preprod, mainnet). */
  tokenFile?: string;
}

/** The token of a profile, outside the profile object (never serialised with it). */
const TOKENS = new WeakMap<NetworkProfile, string>();

const toWs = (url: string): string => url.replace(/^http(s?):/u, 'ws$1:');

function checkUrl(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ProfileError(`${what} is not a URL: ${redactUrl(url)}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol))
    throw new ProfileError(`${what} must be http(s) or ws(s): ${redactUrl(url)}`);
  if (u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '')
    throw new ProfileError(
      `${what} ${redactUrl(url)} must have no query string, fragment or credentials (a Blockfrost token is read from its environment variable or --blockfrost-token-file)`,
    );
  return url.replace(/\/+$/u, '');
}

export function isPublicHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return PUBLIC_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** The public network whose genesis this is, if any. */
export function publicNetworkOfGenesis(genesisHash: string): PublicNetworkId | undefined {
  const g = normGenesis(genesisHash);
  return (Object.keys(PUBLIC_NETWORKS) as PublicNetworkId[]).find((id) => PUBLIC_NETWORKS[id].genesisHash === g);
}

const TOKEN_SHAPE = /^[A-Za-z0-9]{8,128}$/u;

function readToken(id: PublicNetworkId, o: EndpointOverrides, env: Record<string, string | undefined>): { token: string; source: string } {
  const variable = PUBLIC_NETWORKS[id].tokenVariable!;
  let token: string | undefined;
  let source: string;
  if (o.tokenFile !== undefined) {
    source = `--blockfrost-token-file ${o.tokenFile}`;
    try {
      token = readProtectedFile(o.tokenFile).toString('utf8').trim();
    } catch (e) {
      throw new ProfileError(`${id}: ${(e as Error).message}`);
    }
  } else {
    source = variable;
    token = env[variable]?.trim();
  }
  if (!token)
    throw new ProfileError(
      `${id} needs a Blockfrost project token of a Midnight ${id === 'preprod' ? 'Preprod' : 'Mainnet'} project: set ${variable} (or pass --blockfrost-token-file <0600 file>); nothing was sent`,
    );
  if (!TOKEN_SHAPE.test(token))
    throw new ProfileError(`${id}: the token in ${source} is not a Blockfrost project token (letters and digits only)`);
  return { token, source };
}

/** A public network's profile (`env` is read only for the token variable). */
export function publicProfile(
  id: PublicNetworkId,
  o: EndpointOverrides = {},
  env: Record<string, string | undefined> = process.env,
): NetworkProfile {
  const n = PUBLIC_NETWORKS[id];
  if (!n) throw new ProfileError(`unknown public network "${String(id)}"`);
  if (o.genesisHash !== undefined && normGenesis(o.genesisHash) !== n.genesisHash) {
    throw new ProfileError(`the ${id} genesis hash is pinned (${n.genesisHash}) and cannot be overridden`);
  }
  if (n.tokenVariable === undefined && o.tokenFile !== undefined) throw new ProfileError(`${id} takes no Blockfrost token`);
  const indexer = checkUrl(o.indexer ?? n.indexer, 'indexer URL');
  const rpc = checkUrl(o.rpc ?? n.rpc, 'node RPC URL');
  const p: NetworkProfile = {
    id,
    networkId: n.networkId,
    indexer,
    indexerWs: checkUrl(o.indexerWs ?? (o.indexer ? `${toWs(indexer)}/ws` : n.indexerWs), 'indexer WebSocket URL'),
    rpc,
    rpcWs: checkUrl(o.rpcWs ?? (o.rpc ? toWs(rpc) : n.rpcWs), 'node WebSocket URL'),
    genesisHash: n.genesisHash,
    addressPrefixes: { ...n.addressPrefixes },
    public: true,
    minIntervalMs: o.minIntervalMs ?? PUBLIC_MIN_INTERVAL_MS,
  };
  if (o.chainInstance !== undefined) p.chainInstance = normGenesis(o.chainInstance);
  if (n.tokenVariable !== undefined) {
    const { token, source } = readToken(id, o, env);
    attachToken(p, token, source);
  }
  return p;
}

function attachToken(p: NetworkProfile, token: string, source: string): void {
  p.tokenSource = source;
  TOKENS.set(p, token);
  registerSecret(token);
}

/**
 * Test hook of packages/cli/test/e2e/token-e2e.sh: with this variable set, an undeployed profile sends its value as
 * `project_id` exactly like a preprod / mainnet profile, so a full run on the local stack behind a token-checking
 * stub shows that the token reaches no output, log or record.
 */
export const TEST_UNDEPLOYED_TOKEN_VARIABLE = 'MIP0018_TEST_UNDEPLOYED_TOKEN';

export function undeployedProfile(o: EndpointOverrides): NetworkProfile {
  if (!o.indexer) throw new ProfileError('undeployed: the indexer URL is required (--indexer or MIP0018_INDEXER_URL); there is no default');
  if (!o.rpc) throw new ProfileError('undeployed: the node RPC URL is required (--rpc or MIP0018_NODE_URL); there is no default');
  if (o.tokenFile !== undefined) throw new ProfileError('undeployed takes no Blockfrost token');
  const indexer = checkUrl(o.indexer, 'indexer URL');
  const rpc = checkUrl(o.rpc, 'node RPC URL');
  const p: NetworkProfile = {
    id: 'undeployed',
    networkId: 'undeployed',
    indexer,
    indexerWs: checkUrl(o.indexerWs ?? `${toWs(indexer)}/ws`, 'indexer WebSocket URL'),
    rpc,
    rpcWs: checkUrl(o.rpcWs ?? toWs(rpc), 'node WebSocket URL'),
    addressPrefixes: { ...UNDEPLOYED_ADDRESS_PREFIXES },
    public: false,
    minIntervalMs: o.minIntervalMs ?? 0,
  };
  if (o.genesisHash !== undefined) {
    p.genesisHash = normGenesis(o.genesisHash);
    const known = publicNetworkOfGenesis(p.genesisHash);
    if (known) throw new ProfileError(`undeployed: ${p.genesisHash} is the ${known} genesis; refusing`);
  }
  if (o.chainInstance !== undefined) p.chainInstance = normGenesis(o.chainInstance);
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

const isPublicId = (id: string): id is PublicNetworkId => Object.hasOwn(PUBLIC_NETWORKS, id);

/** Reads the profile from CLI flags; the environment supplies undeployed URLs and the Blockfrost token variables. */
export function resolveProfile(
  id: string,
  flags: EndpointOverrides = {},
  env: Record<string, string | undefined> = process.env,
): NetworkProfile {
  if (isPublicId(id)) return publicProfile(id, flags, env);
  if (id === 'undeployed') {
    const o: EndpointOverrides = {
      ...flags,
      indexer: flags.indexer ?? env.MIP0018_INDEXER_URL,
      indexerWs: flags.indexerWs ?? env.MIP0018_INDEXER_WS_URL,
      rpc: flags.rpc ?? env.MIP0018_NODE_URL,
      rpcWs: flags.rpcWs ?? env.MIP0018_NODE_WS_URL,
      genesisHash: flags.genesisHash ?? env.MIP0018_GENESIS_HASH,
    };
    const p = undeployedProfile(o);
    const testToken = env[TEST_UNDEPLOYED_TOKEN_VARIABLE]?.trim();
    if (testToken) {
      if (!TOKEN_SHAPE.test(testToken))
        throw new ProfileError(`${TEST_UNDEPLOYED_TOKEN_VARIABLE} is not token-shaped (letters and digits only)`);
      attachToken(p, testToken, TEST_UNDEPLOYED_TOKEN_VARIABLE);
    }
    return p;
  }
  throw new ProfileError(`unknown network "${id}" (expected one of: ${PROFILE_IDS.join(', ')})`);
}

export function normGenesis(hash: string): string {
  return `0x${normHexBytes(hash, 32, 'block hash')}`;
}

/** A copy of the profile (keeps the profile's token). */
function copyProfile(profile: NetworkProfile): NetworkProfile {
  const p: NetworkProfile = { ...profile, addressPrefixes: { ...profile.addressPrefixes } };
  const token = TOKENS.get(profile);
  if (token !== undefined) TOKENS.set(p, token);
  return p;
}

/** A copy of the profile that also checks block 1 against `chainInstance` (keeps the profile's token). */
export function withChainInstance(profile: NetworkProfile, chainInstance: string): NetworkProfile {
  const p = copyProfile(profile);
  p.chainInstance = normGenesis(chainInstance);
  return p;
}

/** The network identity a file recorded: a run record's or a scanner state's `network`, a case's network.json. */
export interface RecordedNetwork {
  id: string;
  genesisHash?: string;
  chainInstance?: string;
}

/** A recorded network and the file it was read from (named in errors). */
export interface RecordedSource {
  source: string;
  network: RecordedNetwork;
}

/**
 * The profile bound to the networks that files recorded, for a command that reads or writes on their behalf: every
 * file must be of the profile's network; each recorded genesis and chain instance must equal the profile's (the pinned
 * genesis, --genesis, --chain-instance) and every other file's; what the profile lacks is taken from the files. The
 * identity check before the first request then verifies the genesis and block 1 the files name. A conflict is a
 * `ProfileError` naming both values and where they come from. Endpoint URLs are not identity (a mirror or a stub is
 * allowed); the genesis and block 1 decide which chain is read.
 */
export function bindRecordedNetworks(profile: NetworkProfile, recorded: readonly RecordedSource[]): NetworkProfile {
  const p = copyProfile(profile);
  let genesisFrom = `the ${p.id} profile${p.public ? ' (pinned)' : ' (--genesis)'}`;
  let instanceFrom = `the ${p.id} profile (--chain-instance)`;
  for (const { source, network: n } of recorded) {
    if (n.id !== p.id) throw new ProfileError(`${source} is for ${n.id}, not ${p.id}`);
    if (n.genesisHash !== undefined) {
      const g = normGenesis(n.genesisHash);
      if (p.genesisHash === undefined) {
        const known = p.id === 'undeployed' ? publicNetworkOfGenesis(g) : undefined;
        if (known) throw new ProfileError(`undeployed: ${source} records the ${known} genesis ${g}; refusing`);
        p.genesisHash = g;
        genesisFrom = source;
      } else if (p.genesisHash !== g) throw new ProfileError(`${source} records genesis ${g}, but ${genesisFrom} has ${p.genesisHash}`);
    }
    if (n.chainInstance !== undefined) {
      const c = normGenesis(n.chainInstance);
      if (p.chainInstance === undefined) {
        p.chainInstance = c;
        instanceFrom = source;
      } else if (p.chainInstance !== c)
        throw new ProfileError(`${source} records chain instance (block 1) ${c}, but ${instanceFrom} has ${p.chainInstance}`);
    }
  }
  return p;
}

/** The URL a client connects to: the profile URL, with the profile's Blockfrost token as `project_id` if it has one. */
export function connectUrl(profile: NetworkProfile, url: string): string {
  const token = TOKENS.get(profile);
  if (token === undefined) return url;
  const u = new URL(url);
  u.searchParams.set(TOKEN_PARAM, token);
  return u.toString();
}

/** The four endpoints to connect to (wallet SDK, midnight-js providers). Never write these anywhere. */
export function connectUrls(profile: NetworkProfile): { indexer: string; indexerWs: string; rpc: string; rpcWs: string } {
  return {
    indexer: connectUrl(profile, profile.indexer),
    indexerWs: connectUrl(profile, profile.indexerWs),
    rpc: connectUrl(profile, profile.rpc),
    rpcWs: connectUrl(profile, profile.rpcWs),
  };
}

/** An HTTP client with the profile's politeness interval; a refused token (401/403) names where it came from. */
export function httpFor(profile: NetworkProfile): HttpClient {
  return new HttpClient({
    minIntervalMs: profile.minIntervalMs,
    ...(profile.tokenSource
      ? { authHint: `the Blockfrost project token from ${profile.tokenSource} was refused (missing, wrong, or of another network)` }
      : {}),
  });
}

export const indexerFor = (profile: NetworkProfile, http?: HttpClient): Indexer =>
  new Indexer(connectUrl(profile, profile.indexer), connectUrl(profile, profile.indexerWs), http ?? httpFor(profile));

export const rpcFor = (profile: NetworkProfile, http?: HttpClient): NodeRpc =>
  new NodeRpc(connectUrl(profile, profile.rpc), http ?? httpFor(profile));

/**
 * Reads the node's genesis hash and checks it against the profile (and block 1 against the profile's chain instance
 * when it has one). For an undeployed profile without a pinned genesis it refuses the public networks' genesis hashes.
 * Returns the observed genesis.
 */
export async function checkIdentity(profile: NetworkProfile, http?: HttpClient): Promise<string> {
  const rpc = rpcFor(profile, http);
  const body = await rpc.http.postJson<{ result?: string | null; error?: unknown }>(rpc.url, {
    id: 1,
    jsonrpc: '2.0',
    method: 'chain_getBlockHash',
    params: [0],
  });
  if (typeof body.result !== 'string')
    throw new IdentityError(`node ${profile.rpc} did not return a genesis hash: ${scrubSecrets(JSON.stringify(body)).slice(0, 200)}`);
  const genesis = normGenesis(body.result);
  if (profile.genesisHash !== undefined && genesis !== profile.genesisHash) {
    throw new IdentityError(`wrong chain: node genesis ${genesis}, expected ${profile.genesisHash} (${profile.id})`);
  }
  const known = profile.id === 'undeployed' ? publicNetworkOfGenesis(genesis) : undefined;
  if (known) throw new IdentityError(`the undeployed profile points at a node with the ${known} genesis; refusing`);
  if (profile.chainInstance !== undefined) {
    const one = await rpc.blockHash(1);
    if (one === null || normGenesis(one) !== profile.chainInstance)
      throw new IdentityError(
        `another instance of ${profile.id}: node block 1 is ${one ?? 'missing'}, expected ${profile.chainInstance} (same genesis ${genesis}; the network was re-created)`,
      );
  }
  return genesis;
}

/**
 * `checkIdentity`, and the node's chain instance (block 1) for a file that records it: the profile's own when it has
 * one (then verified), otherwise read from the node (null while the node has no block 1).
 */
export async function checkChainIdentity(
  profile: NetworkProfile,
  http?: HttpClient,
): Promise<{ genesisHash: string; chainInstance: string | null }> {
  const genesisHash = await checkIdentity(profile, http);
  if (profile.chainInstance !== undefined) return { genesisHash, chainInstance: profile.chainInstance };
  const one = await rpcFor(profile, http).blockHash(1);
  return { genesisHash, chainInstance: one === null ? null : normGenesis(one) };
}

/**
 * Checks that several recorded networks are the same chain (one id; equal genesis and chain instance wherever two of
 * them record one), e.g. a run record against the scanner state it is looked up in. Throws `ProfileError` otherwise.
 */
export function agreeRecordedNetworks(recorded: readonly RecordedSource[]): void {
  const seen: { id?: RecordedSource; genesisHash?: RecordedSource; chainInstance?: RecordedSource } = {};
  for (const r of recorded) {
    if (seen.id !== undefined && seen.id.network.id !== r.network.id)
      throw new ProfileError(`${r.source} is for ${r.network.id}, but ${seen.id.source} is for ${seen.id.network.id}`);
    seen.id ??= r;
    for (const k of ['genesisHash', 'chainInstance'] as const) {
      const v = r.network[k];
      if (v === undefined) continue;
      const prev = seen[k];
      if (prev === undefined) seen[k] = r;
      else if (normGenesis(prev.network[k]!) !== normGenesis(v))
        throw new ProfileError(
          `${r.source} records ${k === 'genesisHash' ? 'genesis' : 'chain instance (block 1)'} ${normGenesis(v)}, but ${prev.source} has ${normGenesis(prev.network[k]!)}`,
        );
    }
  }
}
