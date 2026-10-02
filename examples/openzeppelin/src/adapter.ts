// SPDX-License-Identifier: Apache-2.0
//
// The `mip0018` CLI adapter of every OpenZeppelin example (each <example>/mip0018.adapter.ts is one line:
// `export const adapter = ozAdapter('<example>')`). It tells the generic deploy/publish path what it cannot guess:
//
//   * compile      the example's contract WITH keys (`npm run compile -w examples/openzeppelin -- --keys
//                  --with-metadata-only <example>`), output <example>/managed/<Contract>
//   * owner        OpenZeppelin `Ownable` (and `FungibleToken`) read the caller's secret through the witnesses
//                  `wit_OwnableSK` / `wit_FungibleTokenSK`; the deployer's fresh 32-byte secret is the private state
//                  (stored only in the signer's 0600 private-state file, never in the run record); the owner id
//                  passed to the constructor is `left(persistentHash<Vector<1, Bytes<32>>>([secret]))`
//   * constructor  the example's metadata.json `contract.constructorArgs` (in order; `initialOwner` is appended):
//                  `deploy --example <name>` with no --args deploys exactly the documented token
//   * calls        metadata.json `steps` (mints, then the publish) → circuit + JSON arguments, with the exact
//                  payload every event must have (checked by `verify` inside `deploy-and-publish`); the same mapping
//                  serves the `lifecycle` steps (rename, withdraw, revive) for `mip0018 publish`
//
// The publish circuits emit literals compiled into the contract, so `--metadata` can only restate them: anything
// else is refused before a transaction is built.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import type { ExpectedState } from '@mip0018/midnight';
import type { AdapterContext, ContractAdapter, MetadataInput, PublishCall } from '@mip0018/midnight/signer';
import { EXAMPLES, exampleDir, type ExampleName } from './examples.ts';

export type OwnerState = { secretKey: Uint8Array };

type MetaStep = {
  id: string;
  circuit: string;
  args: Record<string, unknown>;
  events: { domainSep: string; kind: number; payload: string }[];
  expected?: ExpectedState;
};
type MetaJson = {
  example: string;
  contract: { constructorArgs: Record<string, unknown> };
  identities: (MetadataInput & { decimals?: number })[];
  steps: MetaStep[];
  expected: ExpectedState;
  lifecycle: MetaStep[];
};

export const metadataOf = (example: ExampleName): MetaJson =>
  JSON.parse(readFileSync(join(exampleDir(example), 'metadata.json'), 'utf8')) as MetaJson;

/** OpenZeppelin `Utils.computeAccountId(secretKey)`. */
export const ozAccountId = (secretKey: Uint8Array): Uint8Array =>
  persistentHash(new CompactTypeVector(1, new CompactTypeBytes(32)), [secretKey]);

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

/**
 * The placeholders metadata.json uses for values that depend on who signs (README "metadata.json format"), as CLI
 * argument placeholders. The holder is the signer (deploy-and-publish mints to the deployer, who is the owner).
 */
const ARG_PLACEHOLDERS: Record<string, unknown> = {
  "<the holder's Zswap coin public key>": { bytes: { $signer: 'coinPublicKey' } },
  "<the holder's unshielded user address (32 bytes)>": { bytes: { $signer: 'unshieldedAddress' } },
  '<32 fresh random bytes>': { $random: 32 },
  "left(<the holder's FungibleToken account id>)": { $adapter: 'ownerAccount' },
};

/** One metadata.json value → the CLI's JSON argument (circuit argument order = metadata.json key order). */
function jsonArg(v: unknown, where: string): unknown {
  if (typeof v === 'string') {
    if (v in ARG_PLACEHOLDERS) return ARG_PLACEHOLDERS[v];
    if (v.startsWith('<') || v.startsWith('left(<')) throw new Error(`${where}: no CLI placeholder for ${v}`);
    if (/^0x([0-9a-fA-F]{2})+$/u.test(v)) return v;
    if (/^\d+$/u.test(v)) return v; // Uint amounts as decimal strings
    return { $utf8: v }; // names and symbols: exact UTF-8 bytes (never zero-padded)
  }
  return v; // numbers (kind)
}

/** A metadata.json step (steps or lifecycle) as the CLI call: circuit, JSON arguments, the events it must emit. */
export function callOf(step: MetaStep, where = step.id): PublishCall {
  return {
    circuit: step.circuit,
    stepId: step.id,
    args: Object.entries(step.args).map(([k, v]) => jsonArg(v, `${where}.${k}`)),
    expect: step.events.map((e) => ({ result: 'accept' as const, domainSep: e.domainSep, kind: e.kind, payload: e.payload })),
  };
}

const sameIdentity = (a: MetadataInput, b: MetadataInput): boolean => {
  const std = (x: MetadataInput['standards']) => (x === undefined ? undefined : Array.isArray(x) ? x.join(' ') : x);
  return (
    a.domainSep.toLowerCase().replace(/^0x/u, '') === b.domainSep.toLowerCase().replace(/^0x/u, '') &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.symbol === b.symbol &&
    (a.decimals === undefined ? undefined : Number(a.decimals)) === (b.decimals === undefined ? undefined : Number(b.decimals)) &&
    std(a.standards) === std(b.standards)
  );
};

/** Refuses `--metadata` that the compiled contract cannot emit. */
export function checkMetadata(example: string, given: MetadataInput | undefined, compiled: MetadataInput[]): void {
  if (given === undefined) return;
  if (!compiled.some((c) => sameIdentity(given, c)))
    throw new Error(
      `${example} emits metadata compiled into its contract (${compiled.map((c) => `${c.name}/${c.symbol} kind ${c.kind}`).join(', ')}); --metadata must restate one of its identities or be omitted`,
    );
}

/** Constructor JSON (metadata.json order, without `initialOwner`). */
export const constructorJson = (m: MetaJson): unknown[] =>
  Object.entries(m.contract.constructorArgs)
    .filter(([k]) => k !== 'initialOwner')
    .map(([, v]) => v);

export function ozAdapter(example: ExampleName): ContractAdapter<OwnerState> {
  const contract = EXAMPLES[example].contract;
  const meta = metadataOf(example);
  const names = Object.keys(meta.contract.constructorArgs).filter((k) => k !== 'initialOwner');
  const secret = ({ privateState }: { privateState: OwnerState }): [OwnerState, Uint8Array] => [privateState, privateState.secretKey];
  const owner = (ctx: AdapterContext<OwnerState>) => {
    if (!ctx.privateState?.secretKey) throw new Error(`${example}: no owner private state for this signer`);
    return { is_left: true, left: hex(ozAccountId(ctx.privateState.secretKey)), right: { bytes: ZERO32 } };
  };
  return {
    contract: { name: contract, managedDir: `managed/${contract}` },
    compile: { workspace: 'examples/openzeppelin', script: 'compile', args: ['--keys', '--with-metadata-only', example] },
    witnesses: { wit_OwnableSK: secret, wit_FungibleTokenSK: secret },
    privateStateId: contract,
    initialPrivateState: () => ({ secretKey: Uint8Array.from(randomBytes(32)) }),
    values: (ctx) => ({ ownerAccount: owner(ctx), ownerAccountId: owner(ctx).left }),
    deployArgs: (metadata) => {
      checkMetadata(example, metadata, meta.identities);
      return constructorJson(meta);
    },
    constructorArgs: (json, ctx) => {
      const given = json.length === 0 ? constructorJson(meta) : json;
      if (given.length !== names.length)
        throw new Error(
          `${example}: the constructor takes ${names.join(', ')} (+ initialOwner from the owner secret); got ${given.length} value(s)`,
        );
      const values = given.map((v, i) => {
        const n = names[i]!;
        if (n === 'domainSep') return Uint8Array.from(Buffer.from(String(v).replace(/^0x/u, ''), 'hex'));
        if (n === 'decimals_') return BigInt(v as number);
        return String(v); // Opaque<"string"> name_ / symbol_
      });
      const o = owner(ctx);
      return [...values, { is_left: true, left: Buffer.from(o.left.slice(2), 'hex'), right: { bytes: new Uint8Array(32) } }];
    },
    publish: (metadata) => {
      checkMetadata(example, metadata, meta.identities);
      return meta.steps.map((s) => callOf(s, `${example}.${s.id}`));
    },
  };
}

/** The lifecycle calls of an example (rename, withdraw, revive …) as CLI calls, for walkthroughs and tests. */
export const lifecycleCalls = (example: ExampleName): PublishCall[] =>
  metadataOf(example).lifecycle.map((s) => callOf(s, `${example}.${s.id}`));
