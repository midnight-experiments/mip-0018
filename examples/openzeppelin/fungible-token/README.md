# examples/openzeppelin/fungible-token — a ledger token (kind 3)

An OpenZeppelin `FungibleToken` (public balances, ERC-20 shape) owned with `Ownable`, from
[OpenZeppelin Compact Contracts 0.4.0-alpha.5](https://github.com/OpenZeppelin/compact-contracts/tree/v0.4.0-alpha.5),
gains MIP-0018 metadata: the owner publishes its `name`, `symbol` and `decimals` once after deployment,
and can rename or withdraw them later.

| | |
|---|---|
| Start from | [`contracts/without-metadata/MyFungibleToken.compact`](contracts/without-metadata/MyFungibleToken.compact) |
| Result | [`contracts/MyFungibleToken.compact`](contracts/MyFungibleToken.compact) |
| MIP `kind` | 3 (ledger token: no color, no mint effect) |
| `domainSep` | a constant you choose once: `pad(32, "mip-0018:example:fungible")` — `FungibleToken` has no domain of its own |
| Published | `name` "Acme Gold", `symbol` "AGLD" (the same literals the deployer passes to `initialize`), `decimals` read from `FungibleToken__decimals` |
| Access control | `Ownable_assertOnlyOwner()` on every emitting circuit |
| What to publish and expect | [`metadata.json`](metadata.json) |

## Add these lines

<!-- readme-diff from="contracts/without-metadata/MyFungibleToken.compact" to="contracts/MyFungibleToken.compact" -->
```diff
@@ -12,4 +12,5 @@
 import "@openzeppelin/compact-contracts/access/Ownable" prefix Ownable_;
 import "@openzeppelin/compact-contracts/token/FungibleToken" prefix FungibleToken_;
+import "@mip0018/compact/src/Mip0018" prefix Mip0018_;

 export { Either, ContractAddress };
@@ -54,2 +55,33 @@
   FungibleToken__burn(account, value);
 }
+
+// MIP-0018 metadata. A ledger token (kind 3) has no domain separator of its own: this constant
+// is its `domainSep`. Choose it once; changing it later describes a different token.
+pure circuit metadataDomain(): Bytes<32> {
+  return pad(32, "mip-0018:example:fungible");
+}
+
+// Call right after deployment (a constructor cannot emit). The same literals as the
+// constructor's `name_` and `symbol_`; `decimals` is read from the token's own state.
+export circuit publishMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_commonFields<9, 4>(
+    metadataDomain(), Mip0018_KIND_LEDGER(), "Acme Gold", "AGLD", FungibleToken__decimals));
+}
+
+// Rename (an extraordinary update): a new 9-byte name and 4-byte symbol; other fields keep
+// their values. The sizes are part of the circuit; values must be valid UTF-8.
+export circuit setMetadata(newName: Bytes<9>, newSymbol: Bytes<4>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_payload2<4, 9, 6, 4>(
+    Mip0018_header(metadataDomain(), Mip0018_KIND_LEDGER()),
+    Mip0018_nameRecord<9>(newName),
+    Mip0018_symbolRecord<4>(newSymbol)));
+}
+
+// Withdraw: one event with a Null record for each key (name, symbol, decimals, standards);
+// with no field left, consumers do not reference the token at all.
+export circuit withdrawMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_withdraw(metadataDomain(), Mip0018_KIND_LEDGER()));
+}
```

That is the whole change: one import and three circuits. `mint`, `transfer` and `burn` are untouched
and emit nothing ("Normal token operation … MUST NOT emit metadata events").

- **`metadataDomain()`** — a ledger token's `domainSep` is any stable 32 bytes the contract chooses
  (MIP "Token identity and authority"). Keep it a constant: changing it describes a different token.
  Because it is a literal, `publishMetadata()` stays small (k = 13 with the owner check).
- **The same literals as `initialize`** — OpenZeppelin stores `name` and `symbol` as
  `Opaque<"string">`, which a circuit cannot turn into bytes, so the circuit repeats them as `Bytes`
  literals. Pass exactly these strings to the constructor (the deploy scripts take both from
  `metadata.json`). `decimals` is a `Uint<8>`, so the circuit reads it from the token's state.
- **Sizes are part of a circuit** — `commonFields<9, 4>` because "Acme Gold" is 9 bytes and "AGLD"
  4; the compiler rejects a mismatch. `setMetadata` renames to another 9-byte name and 4-byte symbol;
  for other lengths add a circuit (to a deployed contract: `VerifierKeyInsert`, see
  `examples/upgrade-existing-contract`). Never zero-pad a shorter value to fit: the zeros would be
  part of the emitted name ([`../test/exact-values.test.ts`](../test/exact-values.test.ts)).
- **No `standards`** — OpenZeppelin's `FungibleToken` does not claim a MIP standard, so the example
  claims none. To claim one your token implements, publish
  `Mip0018_commonFieldsWithStandards<9, 4, T>(…, "<identifiers>")` instead.
- **Renames do not change the getters** — `name()` and `symbol()` keep returning the constructor
  values (they are `sealed`); after `setMetadata` the MIP-0018 metadata is the current one.

## Deploy and publish

1. Deploy `MyFungibleToken` with `name_ = "Acme Gold"`, `symbol_ = "AGLD"`, `decimals_ = 6` and
   `initialOwner = left(<your Ownable account id>)` (account id = `persistentHash([secretKey])`;
   `wit_OwnableSK` returns the secret key).
2. Call `publishMetadata()` as the owner right away. One `Misc` event, bound to the contract,
   payload = `metadata.json` → `steps[0].events[0].payload`.

A consumer then shows one kind-3 identity with `name` "Acme Gold", `symbol` "AGLD",
`decimals` 6, no color, in a one-member symbol group (`metadata.json` → `expected`).

## Tests

```sh
docker/run.sh exec 'npx vitest run examples/openzeppelin/fungible-token'
```

[`test/fungible-token.test.ts`](test/fungible-token.test.ts), in compact-runtime 0.20.0 (no chain):

| Test | Shows |
|---|---|
| metadata.json payloads | every expected payload equals the reference encoder (`@mip0018/codec`) |
| exact values | every emitted event of every step, decoded with `@mip0018/codec`: header and each key and value equal `metadata.json` exactly (no zero padding, `decimals` 1 byte) |
| publish | one `Misc` event, name `mip-0018:token-metadata[v1]`, payload = `metadata.json`, decoded values = the constructor literals, `decimals` from state |
| lifecycle | publish → rename → withdraw → withdraw again → revive: payload bytes and the reference consumer's state equal `metadata.json` after every step (after the withdrawal the token is not listed; the repeated withdrawal changes nothing; the revive lists it again with only the revived name and symbol) |
| no color | the consumer derives no color for kind 3; minting creates no native mint effect |
| normal operation | `mint`, `transfer`, `burn` emit no event (with and without metadata) and move balances as expected |
| access control | a non-owner `publishMetadata`, `setMetadata`, `withdrawMetadata`, `mint`, `burn` fails (`Ownable: caller is not the owner`), nothing emitted |
| the diff | the contract with metadata deploys exactly three more circuits than the one without |

Circuit sizes: [`../README.md`](../README.md#costs).
