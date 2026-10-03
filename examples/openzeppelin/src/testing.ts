// SPDX-License-Identifier: Apache-2.0
//
// Shared test helpers for the OpenZeppelin examples (no chain):
//   * the compact-runtime harness of packages/compact (`Simulator`: deploy, call, captured events);
//   * deterministic contract addresses, OpenZeppelin `Ownable` account ids and argument shapes;
//   * the mints of a call (shielded coin outputs, unshielded UTXO claims, mint effects) and their
//     colors next to `rawTokenType(domainSep, contractAddress)`;
//   * each example's metadata.json (what to publish, the expected payload bytes and consumer state)
//     and the reference consumer (`@mip0018/consumer`) to apply emitted events in order.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { commonRecords, encodePayload, fromHex, toHex, withdrawRecords, type MetadataRecord } from '@mip0018/codec';
import { Simulator, type CallOutcome } from '@mip0018/compact/testing';
import { MetadataState, type IdentityView } from '@mip0018/consumer';
import { exampleDir, type ExampleName } from './examples.ts';

export { Simulator, type CallOutcome, type ObservedMisc } from '@mip0018/compact/testing';

// ------------------------------------------------------------------------------------- identities

/** A deterministic contract address per label (sha256), so colors are reproducible across runs. */
export const exampleAddress = (label: string): string =>
  createHash('sha256').update(`mip-0018:examples:openzeppelin:${label}`).digest('hex');

/** `pad(32, text)` as Compact computes it (UTF-8, zero-padded). */
export const pad32 = (text: string): Uint8Array => {
  const b = new TextEncoder().encode(text);
  if (b.length > 32) throw new Error(`"${text}" is longer than 32 bytes`);
  const out = new Uint8Array(32);
  out.set(b);
  return out;
};

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const hex0x = (b: Uint8Array): string => `0x${toHex(b)}`;

/** OpenZeppelin `Utils.computeAccountId(secretKey)` = persistentHash<Vector<1, Bytes<32>>>([secretKey]) (`Ownable`, `FungibleToken`). */
export const accountId = (secretKey: Uint8Array): Uint8Array =>
  rt.persistentHash(new rt.CompactTypeVector(1, new rt.CompactTypeBytes(32)), [secretKey]);

/** Private state of every example: the caller's secret key, read by OpenZeppelin's witnesses. */
export type OzPrivateState = { secretKey: Uint8Array };

const secretKeyWitness = ({ privateState }: { privateState: OzPrivateState }): [OzPrivateState, Uint8Array] => [
  privateState,
  privateState.secretKey,
];

/** `wit_OwnableSK` (Ownable) and `wit_FungibleTokenSK` (FungibleToken), both answered from the private state. */
export const ozWitnesses = { wit_OwnableSK: secretKeyWitness, wit_FungibleTokenSK: secretKeyWitness };

const ZERO32 = new Uint8Array(32);

/** `Either<Bytes<32>, ContractAddress>` holding an account id (Ownable owner, FungibleToken account). */
export const account = (id: Uint8Array) => ({ is_left: true, left: id, right: { bytes: ZERO32 } });
/** `ZswapCoinPublicKey`. */
export const coinPublicKey = (bytes: Uint8Array) => ({ bytes });
/** `Either<ContractAddress, UserAddress>` holding a user address (recipient of an unshielded mint). */
export const userAddress = (bytes: Uint8Array) => ({ is_left: false, left: { bytes: ZERO32 }, right: { bytes } });

/** The circuits a compiled contract deploys (impure, i.e. each one gets a verifier key), from contract-info.json. */
export const deployedCircuits = (managed: string): string[] =>
  (
    JSON.parse(readFileSync(join(managed, 'compiler', 'contract-info.json'), 'utf8')) as {
      circuits: { name: string; pure: boolean }[];
    }
  ).circuits
    .filter((c) => !c.pure)
    .map((c) => c.name)
    .sort();

/** Deploys an example contract as `secretKey` at a deterministic address. */
export const deployAs = (
  managed: string,
  secretKey: Uint8Array,
  args: readonly unknown[],
  address: string,
): Promise<Simulator<OzPrivateState>> =>
  Simulator.deploy<OzPrivateState>(managed, { witnesses: ozWitnesses, privateState: { secretKey }, args, address });

/** Calls a circuit as the holder of `secretKey`. */
export const callAs = <R = unknown>(
  sim: Simulator<OzPrivateState>,
  secretKey: Uint8Array,
  circuit: string,
  ...args: unknown[]
): Promise<CallOutcome<R>> => {
  sim.currentPrivateState = { secretKey };
  return sim.call<R>(circuit, ...args);
};

// ------------------------------------------------------------------------------------- mints and colors

/** `rawTokenType(domainSep, contractAddress)` from the official runtime (hex, no 0x). */
export const colorOf = (domainSep: Uint8Array, contractAddress: string): string => rt.rawTokenType(domainSep, contractAddress);

export type ObservedMints = {
  /** Mint effects of the call: hex domainSep -> amount (`kernel.mintShielded`). */
  shieldedMints: Map<string, bigint>;
  /** Mint effects of the call: hex domainSep -> amount (`kernel.mintUnshielded`). */
  unshieldedMints: Map<string, bigint>;
  /** The shielded coins the call created (Zswap outputs), with their colors. */
  shieldedOutputs: { color: string; value: bigint; recipientIsUser: boolean }[];
  /** The unshielded UTXOs the call creates for a recipient (claimed unshielded spends), with their colors. */
  unshieldedOutputs: { color: string; amount: bigint; tag: string }[];
};

type EncodedOutput = { coinInfo: { color: Uint8Array | string; value: bigint }; recipient: { is_left: boolean } };

/** The mints of one call, read from its proof data (final transcript effects and Zswap local state). */
export const mintsOf = (out: CallOutcome): ObservedMints => {
  const pd = out.proofData;
  if (!pd) throw new Error('the call produced no proof data');
  const effects = pd.finalQueryContext.effects;
  const outputs = (pd.zswapLocalState.outputs ?? []) as unknown as EncodedOutput[];
  return {
    shieldedMints: new Map(effects.shieldedMints),
    unshieldedMints: new Map(effects.unshieldedMints),
    shieldedOutputs: outputs.map((o) => ({
      color: typeof o.coinInfo.color === 'string' ? o.coinInfo.color : toHex(o.coinInfo.color),
      value: o.coinInfo.value,
      recipientIsUser: o.recipient.is_left,
    })),
    unshieldedOutputs: [...effects.claimedUnshieldedSpends.entries()].map(([[tokenType], amount]) => ({
      color: tokenType.tag === 'dust' ? '' : tokenType.raw,
      amount,
      tag: tokenType.tag,
    })),
  };
};

// ------------------------------------------------------------------------------------- metadata.json

/** One identity's metadata, in the shape `mip0018 deploy-and-publish --metadata` and `verify --expect` use. */
export type IdentityMetadata = {
  domainSep: string;
  kind: 1 | 2 | 3;
  name?: string;
  symbol?: string;
  decimals?: number;
  standards?: string;
};

/**
 * One expected event: the identity, its records (common fields, or `withdraw`: Null records at `name`, `symbol`,
 * `decimals` and `standards`) and the exact payload.
 */
export type ExpectedEvent = IdentityMetadata & { withdraw?: true; payload: string };

export type ExpectedState = {
  /** Every identity that has at least one field; a withdrawn one (every field deleted) is not listed. */
  identities: { domainSep: string; kind: number; colored: boolean; common: Record<string, unknown> }[];
  groups: { symbol: string; members: { domainSep: string; kind: number }[] }[];
};

export type Step = {
  id: string;
  circuit: string;
  args: Record<string, unknown>;
  caller: 'owner' | 'anyone';
  events: ExpectedEvent[];
  mints?: { kind: 1 | 2; domainSep: string; amount: string }[];
  expected?: ExpectedState;
};

export type ExampleMetadata = {
  example: ExampleName;
  mip: { commit: string; eventName: string };
  contract: { source: string; withoutMetadata: string; openzeppelin: string; constructorArgs: Record<string, unknown> };
  identities: IdentityMetadata[];
  steps: Step[];
  expected: ExpectedState;
  lifecycle: Step[];
};

export const loadMetadata = (example: ExampleName): ExampleMetadata =>
  JSON.parse(readFileSync(join(exampleDir(example), 'metadata.json'), 'utf8')) as ExampleMetadata;

/** The records an expected event carries, in emission order. */
export const eventRecords = (e: ExpectedEvent): MetadataRecord[] =>
  e.withdraw ? withdrawRecords() : commonRecords({ name: e.name, symbol: e.symbol, decimals: e.decimals, standards: e.standards });

/** The payload the reference encoder (`@mip0018/codec`) produces for an expected event. */
export const encodeExpected = (e: ExpectedEvent): Uint8Array =>
  encodePayload({ domainSep: fromHex(e.domainSep), kind: e.kind }, eventRecords(e));

// ------------------------------------------------------------------------------------- consumer

/**
 * The reference consumer with the official `rawTokenType` as its color function, plus a chain
 * position counter: each `apply(address, outcome)` puts the call's Misc events in the next block.
 */
export class Chain {
  readonly state = new MetadataState({
    tokenType: (domainSep, contractAddress) => fromHex(rt.rawTokenType(domainSep, toHex(contractAddress))),
  });
  private block = 0;
  readonly network: string;

  constructor(network = 'undeployed') {
    this.network = network;
  }

  apply(outcome: CallOutcome): void {
    this.block += 1;
    outcome.misc.forEach((m, event) => {
      const r = this.state.apply({
        network: this.network,
        contractAddress: m.address,
        block: this.block,
        tx: 0,
        event,
        type: 'Misc',
        ...m,
      });
      if (r.result !== 'accept') throw new Error(`event ${event} of block ${this.block} was ${r.result}: ${JSON.stringify(r)}`);
    });
  }

  identity(address: string, domainSep: string, kind: number): IdentityView | undefined {
    return this.state.identity(this.network, address, domainSep.replace(/^0x/u, ''), kind);
  }

  /** The consumer's state in the shape of metadata.json `expected` (one contract). */
  snapshot(address: string): ExpectedState {
    const common = (v: IdentityView): Record<string, unknown> => {
      const c: Record<string, unknown> = {};
      if (v.common.name !== undefined) c.name = v.common.name;
      if (v.common.symbol !== undefined) c.symbol = v.common.symbol;
      if (v.common.decimals !== undefined) c.decimals = Number(v.common.decimals);
      if (v.common.standards !== undefined) c.standards = v.common.standards.join(' ');
      return c;
    };
    return {
      identities: this.state
        .identities()
        .filter((v) => v.contractAddress === address)
        .map((v) => ({ domainSep: `0x${v.domainSep}`, kind: v.kind, colored: v.colored, common: common(v) })),
      groups: this.state
        .groups()
        .filter((g) => g.contractAddress === address)
        .map((g) => ({
          symbol: new TextDecoder().decode(g.symbol),
          members: g.members.map((m) => ({ domainSep: `0x${m.domainSep}`, kind: m.kind })),
        })),
    };
  }
}
