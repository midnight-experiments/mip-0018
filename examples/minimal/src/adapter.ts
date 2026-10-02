// SPDX-License-Identifier: Apache-2.0
//
// The `mip0018` CLI adapters of the minimal example (no OpenZeppelin):
//
//   examples/minimal/mip0018.adapter.ts               CreateAndDestroy  (`--example minimal`; create-and-destroy, Q4)
//   examples/minimal/owner-key.mip0018.adapter.ts     OwnerKey          (`--adapter …`; publish, rename, withdraw)
//   examples/minimal/publish-once.mip0018.adapter.ts  PublishOnce       (`--adapter …`)
//
// What the generic path cannot guess:
//   * compile      the contract WITH keys (`npm run compile -w examples/minimal -- --keys <Contract>`)
//   * secret       the `secretKey` witness reads the deployer's fresh 32-byte secret (the private state, kept only
//                  in the signer's 0600 private-state file); its account id
//                  `persistentHash<Vector<2, Bytes<32>>>([pad(32, "mip0018:minimal:account"), secret])` is the
//                  holder of the initial supply (CreateAndDestroy, PublishOnce) or the owner (OwnerKey)
//   * constructor  [domainSep, supply] or [domainSep] — the domainSep IS a constructor argument here, so
//                  `deploy-and-publish --metadata` may choose it; the other values are compiled-in literals
//                  (MIP Appendix A: "Acme Token", "ACME", 6, "mip-0004") and must be restated exactly
//   * calls        metadata.json `steps` (publish) and, for OwnerKey, the `lifecycle` (rename, withdraw, revive)

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import type { ExpectedState } from '@mip0018/midnight';
import type { AdapterContext, ContractAdapter, MetadataInput, PublishCall } from '@mip0018/midnight/signer';
import { EXAMPLE_DIR, witnesses, type MinimalContract, type MinimalPrivateState } from './contracts.ts';

type MetaStep = {
  id: string;
  circuit: string;
  args: Record<string, unknown>;
  events: (MetadataInput & { tombstone?: true; payload: string })[];
  expected?: ExpectedState;
};
type MetaJson = {
  contract: { constructorArgs: Record<string, unknown> };
  identities: MetadataInput[];
  steps: MetaStep[];
  expected: ExpectedState;
  lifecycle: MetaStep[];
};

export const metadataFile = (c: MinimalContract) => join(EXAMPLE_DIR, c === 'OwnerKey' ? 'owner-key.metadata.json' : 'metadata.json');
export const metadataOf = (c: MinimalContract): MetaJson => JSON.parse(readFileSync(metadataFile(c), 'utf8')) as MetaJson;

const pad32 = (text: string) => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(text));
  return b;
};
/** The minimal token's account id of a secret key (MinimalToken.accountId). */
export const minimalAccountId = (sk: Uint8Array): Uint8Array =>
  persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [pad32('mip0018:minimal:account'), sk]);

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;

/** A metadata.json step as a CLI call (names and symbols as exact UTF-8, never zero-padded). */
export function callOf(step: MetaStep): PublishCall {
  return {
    circuit: step.circuit,
    stepId: step.id,
    args: Object.values(step.args).map((v) => (typeof v === 'string' && !/^0x/u.test(v) ? { $utf8: v } : v)),
    expect: step.events.map((e) => ({ result: 'accept' as const, domainSep: e.domainSep, kind: e.kind, payload: e.payload })),
  };
}

/** The identity the contract emits for `domainSep`: everything but the domainSep is compiled in. */
function effective(meta: MetaJson, given: MetadataInput | undefined): MetadataInput {
  const lit = meta.identities[0]!;
  if (given === undefined) return lit;
  const std = (x: MetadataInput['standards']) => (Array.isArray(x) ? x.join(' ') : x);
  if (
    given.kind !== lit.kind ||
    given.name !== lit.name ||
    given.symbol !== lit.symbol ||
    Number(given.decimals) !== Number(lit.decimals) ||
    std(given.standards) !== std(lit.standards)
  )
    throw new Error(
      `the minimal contracts emit the compiled-in values ${lit.name}/${lit.symbol}/${lit.decimals}/${std(lit.standards)} (kind ${lit.kind}); --metadata may only choose the domainSep`,
    );
  if (!/^(0x)?[0-9a-fA-F]{64}$/u.test(given.domainSep)) throw new Error('--metadata domainSep must be 32 bytes of hex');
  return { ...lit, domainSep: `0x${given.domainSep.replace(/^0x/u, '').toLowerCase()}` };
}

export function minimalAdapter(contract: MinimalContract): ContractAdapter<MinimalPrivateState> {
  const meta = metadataOf(contract);
  const withSupply = contract !== 'OwnerKey';
  const account = (ctx: AdapterContext<MinimalPrivateState>) => {
    if (!ctx.privateState?.secretKey) throw new Error(`${contract}: no private state (secret key) for this signer`);
    return minimalAccountId(ctx.privateState.secretKey);
  };
  return {
    contract: { name: contract, managedDir: `managed/${contract}` },
    compile: { workspace: 'examples/minimal', script: 'compile', args: ['--keys', contract] },
    witnesses,
    privateStateId: contract,
    initialPrivateState: () => ({ secretKey: Uint8Array.from(randomBytes(32)) }),
    values: (ctx) => ({ accountId: hex(account(ctx)) }),
    deployArgs: (metadata) => {
      const id = effective(meta, metadata);
      return withSupply ? [id.domainSep, String(meta.contract.constructorArgs.supply)] : [id.domainSep];
    },
    constructorArgs: (json, ctx) => {
      const [domainSep, supply] = (
        json.length === 0
          ? withSupply
            ? [meta.contract.constructorArgs.domainSep, meta.contract.constructorArgs.supply]
            : [meta.contract.constructorArgs.domainSep]
          : json
      ) as [string, string?];
      const ds = Uint8Array.from(Buffer.from(String(domainSep).replace(/^0x/u, ''), 'hex'));
      if (ds.length !== 32) throw new Error(`${contract}: domainSep must be 32 bytes`);
      return withSupply ? [ds, BigInt(supply ?? (meta.contract.constructorArgs.supply as string)), account(ctx)] : [ds, account(ctx)];
    },
    publish: (metadata) => {
      const id = effective(meta, metadata);
      return meta.steps.map((s) => ({
        ...callOf(s),
        expect: [
          {
            result: 'accept' as const,
            metadata: {
              domainSep: id.domainSep,
              kind: id.kind,
              name: id.name,
              symbol: id.symbol,
              decimals: id.decimals,
              standards: id.standards,
            },
          },
        ],
      }));
    },
  };
}

/** OwnerKey's lifecycle (rename, withdraw, withdraw again, revive) as CLI calls. */
export const lifecycleCalls = (contract: MinimalContract = 'OwnerKey'): PublishCall[] => metadataOf(contract).lifecycle.map(callOf);
