# examples/openzeppelin — add MIP-0018 metadata to an OpenZeppelin token

[OpenZeppelin Compact Contracts](https://github.com/OpenZeppelin/compact-contracts) is the token
library most Compact contracts start from. Its token modules have no events, so a wallet or explorer
cannot learn what an OpenZeppelin token is called. These examples take an OpenZeppelin token, add the
lines that publish MIP-0018 `TokenMetadata` events with this repository's Compact module
([`packages/compact`](../../packages/compact)), and test the result.

Pinned: **`@openzeppelin/compact-contracts@0.4.0-alpha.5`** (Ledger v9, built upstream for Compact
0.34.0), compiled here with **Compact 0.35.0 (language 0.27.0) and `--feature-zkir-v3`** — every
example compiles with no compiler message. Access control is OpenZeppelin `Ownable` (owner decision Q4).

| Example | Token | OpenZeppelin modules | MIP `kind` | `domainSep` | Color |
|---|---|---|---|---|---|
| [`fungible-token`](fungible-token) | ledger token, ERC-20 shape | `FungibleToken` + `Ownable` | 3 | a constant the contract chooses | none |
| [`native-shielded`](native-shielded) | shielded coins, one type | `NativeShieldedToken` + `Ownable` | 1 | `NativeShieldedToken__domain` | `tokenType(domainSep, contract)` |
| [`native-unshielded`](native-unshielded) | unshielded UTXOs, one type | `Ownable` only — **OpenZeppelin has no unshielded module**; the standard library's `mintUnshieldedToken` | 2 | the contract's `_domain` | `tokenType(domainSep, contract)` |
| [`multi-kind`](multi-kind) | one asset as shielded coins, unshielded UTXOs and ledger balances | `NativeShieldedToken` + `FungibleToken` + `Ownable` (+ `mintUnshieldedToken`) | 1, 2, 3 | one, `NativeShieldedToken__domain` | kinds 1 and 2: the same color |
| [`token-family`](token-family) | many shielded token types | `NativeShieldedTokenFamily` + `Ownable` | 1 per type | the type's `domain` | one per type |

Each example has the OpenZeppelin token you start from (`contracts/without-metadata/`), the same
token with metadata (`contracts/`), a README whose "Add these lines" diff is checked against both
files, a [`metadata.json`](#metadatajson) with what to publish and what a consumer must conclude, and
runtime tests.

## The recipe

Every example adds the same four things. From [`fungible-token`](fungible-token) (checked excerpt):

<!-- readme-snippet file="fungible-token/contracts/MyFungibleToken.compact" -->
```compact
import "@mip0018/compact/src/Mip0018" prefix Mip0018_;
// ...
export circuit publishMetadata(): [] {
  Ownable_assertOnlyOwner();
  Mip0018_emitPayload(Mip0018_commonFields<9, 4>(
    metadataDomain(), Mip0018_KIND_LEDGER(), "Acme Gold", "AGLD", FungibleToken__decimals));
}
// ...
export circuit setMetadata(newName: Bytes<9>, newSymbol: Bytes<4>): [] {
  Ownable_assertOnlyOwner();
  Mip0018_emitPayload(Mip0018_payload2<4, 9, 6, 4>(
    Mip0018_header(metadataDomain(), Mip0018_KIND_LEDGER()),
    Mip0018_nameRecord<9>(newName),
    Mip0018_symbolRecord<4>(newSymbol)));
}
// ...
export circuit withdrawMetadata(): [] {
  Ownable_assertOnlyOwner();
  Mip0018_emitPayload(Mip0018_tombstone(metadataDomain(), Mip0018_KIND_LEDGER()));
}
```

1. **Import the module** — `import "@mip0018/compact/src/Mip0018" prefix Mip0018_;`, next to the
   OpenZeppelin imports (both resolved with `--compact-path <repo>/node_modules`; a relative path to
   `packages/compact/src/Mip0018` works too).
2. **Add `publishMetadata()`** — the owner check first, then one `Mip0018_emitPayload(...)` per token
   identity, built with the typed constructor (`commonFields<N, S>`; the generic arguments are the byte
   lengths of the name and symbol, checked by the compiler):
   - `domainSep` and `kind` as in the table above: for a native token the **same** `domainSep` its
     mints use (read it from the module's state), so the color a consumer derives,
     `tokenType(domainSep, contractAddress)`, is the color of the coins;
   - `name` and `symbol`: **the same literals the deployer passes to `initialize`**. OpenZeppelin
     stores them as `Opaque<"string">`, which a circuit cannot turn into bytes, so the circuit repeats
     them. Nothing checks the two against each other (owner ruling: such a check becomes possible
     once consumers can execute getters); the deploy scripts take both from `metadata.json`;
   - `decimals`: read from the module's `_decimals` (`Uint<8>`), so it always equals the getter.
3. **Add `setMetadata(...)` and `withdrawMetadata()`** — owner-only rename (an extraordinary update;
   a new value of exactly the circuit's byte length) and tombstone (consumers hide the identity and
   clear all its fields). Both are optional; without them the metadata can still be changed later
   by inserting a circuit with a maintenance update (`examples/upgrade-existing-contract`).
4. **Deploy, then call `publishMetadata()` right away** — a Compact constructor cannot emit (and
   OpenZeppelin's `initialize` must be the only token operation in the constructor anyway).

Never call `emitPayload` from `mint`, `transfer` or `burn`: "Normal token operation … MUST NOT emit
metadata events" (every example tests that these emit nothing).

## What OpenZeppelin users should know

- **Token modules have no access control.** Guard every emitting circuit: anyone who can call it can
  rename or withdraw the token (MIP "Publishing"). The examples use `Ownable_assertOnlyOwner()`;
  `AccessControl_assertOnlyRole(...)` or `ZOwnablePK_assertOnlyOwner()` work the same way.
- **Do not use `Initializable` for a publish-once flag.** Modules importing the same stateful module
  share its state (LFDT-Minokawa/compact#270); OpenZeppelin's own modules stopped composing it. Keep
  your own `ledger metadataPublished: Boolean` if you want publish-once
  (`examples/minimal/contracts/PublishOnce.compact`).
- **Renames do not change the getters.** `name()` / `symbol()` return the `sealed` constructor values
  forever; after `setMetadata` the MIP-0018 metadata is the current one (renames are the MIP's
  "extraordinary updates").
- **Claim only the standards your token implements.** OpenZeppelin 0.4.0-alpha.5 claims no MIP, so the
  examples publish no `standards` (questions Q25). To claim some, use
  `Mip0018_commonFieldsWithStandards<N, S, T>(…, "mip-00xx …")`.
- **The generated TypeScript `Ledger` type does not include module state** (OpenZeppelin's `_balances`,
  `_domain`, …): read it through circuits (`balanceOf`, `tokenColor`) or re-export the fields.
- **Never pad a value with zeros.** MIP-0018 compares keys and values as exact bytes: `"AGL"` in a
  `Bytes<4>` is `"AGL\0"`, a different symbol. With the module's builders a literal of the wrong length
  does not compile, and the runtime refuses a too-short argument — but an argument zero-padded to the
  circuit's size is emitted with its zeros. Make every generic size the value's UTF-8 byte length (the
  tests decode every emitted event and compare each value with `metadata.json`;
  [`test/exact-values.test.ts`](test/exact-values.test.ts) shows the padded case).
- **Sizes and costs.** A literal `domainSep` keeps `publishMetadata()` at k = 13; reading it from state
  (native tokens) costs k = 15; three events in one circuit k = 16 (table below).

## Build and test

```sh
docker/run.sh exec 'npm run -w examples/openzeppelin compile'              # all, --skip-zk (add -- --keys for keys)
docker/run.sh exec 'npx vitest run examples/openzeppelin'                  # runtime tests (no chain)
docker/run.sh exec 'npm run -w examples/openzeppelin check:readmes'        # README diffs = sources
docker/run.sh exec 'node examples/openzeppelin/scripts/payload-hex.ts --fill <example>/metadata.json'
```

The tests run the compiled contracts in compact-runtime 0.20.0 with the harness of
`packages/compact` (`@mip0018/compact/testing`), read the minted coins' and UTXOs' colors from the
call's effects, and apply the emitted events with the reference consumer (`@mip0018/consumer`).
Shared helpers: [`src/testing.ts`](src/testing.ts), [`src/expect.ts`](src/expect.ts).

## metadata.json

One file per example: what to deploy and publish (used by the Stagenet cases) and what a conforming
consumer must conclude. The tests check every byte and every state in it against the contract.

| Field | Content |
|---|---|
| `contract` | source paths, OpenZeppelin modules, `constructorArgs` (the literals to pass to `initialize`) |
| `identities[]` | each token identity's metadata as `{domainSep, kind, name, symbol, decimals}` — the shape `mip0018 deploy-and-publish --metadata` and `verify --expect '{"metadata": …}'` take |
| `steps[]` | what to do after deployment, in order: `{id, circuit, args, caller, events[], mints[]}`; each event is an identity plus `payload` (the exact 256 bytes, hex, from `@mip0018/codec`; `scripts/payload-hex.ts --fill` writes them) |
| `expected` | the consumer state after `steps`: per identity `visible`, `colored`, the usable common fields; the symbol groups. Colors depend on the deployed address: `rawTokenType(domainSep, contractAddress)` for kinds 1 and 2 |
| `lifecycle[]` | later updates (rename, withdraw, withdraw again, revive), each with its `expected` state |

Arguments in angle brackets (`<the holder's Zswap coin public key>`) are chosen at run time.

## Costs

Every deployed circuit of the five examples, full keys (`node examples/openzeppelin/scripts/costs.ts`;
the module's own measurements are in [`docs/costs.md`](../../docs/costs.md)). **Bold** = the circuits
the examples add.

<!-- oz-costs:begin -->
<!-- oz-costs:end -->

## Not here

- Nothing is proposed or contributed to OpenZeppelin (owner decision Q6).
- Conversion between representations (OpenZeppelin's `NativeTokenConverter` is not on `main`).
- Deploying: see [`examples/publish-and-emit`](../publish-and-emit) and the Stagenet cases in
  [`deployments/stagenet`](../../deployments/stagenet).
