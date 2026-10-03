# examples/openzeppelin/token-family — several token types, one contract (kind 1 × 3)

An OpenZeppelin `NativeShieldedTokenFamily` (many native shielded token types; each mint names its
32-byte `domain`) owned with `Ownable`, from
[OpenZeppelin Compact Contracts 0.4.0-alpha.5](https://github.com/OpenZeppelin/compact-contracts/tree/v0.4.0-alpha.5),
gains MIP-0018 metadata. Each `domain` is its own token identity with its own color, so each gets its
own event(s): here three types, `gold`, `silver` and `bronze`.

| | |
|---|---|
| Start from | [`contracts/without-metadata/MyTokenFamily.compact`](contracts/without-metadata/MyTokenFamily.compact) |
| Result | [`contracts/MyTokenFamily.compact`](contracts/MyTokenFamily.compact) |
| MIP `kind` | 1 for every type (native shielded) |
| `domainSep` | the `domain` of the type, a circuit argument as in the family's own `mint(domain, …)`: `pad(32, "mip-0018:example:family:gold")`, `…:silver`, `…:bronze` |
| Published | per type: `name` "Acme Medals", `symbol` "MEDAL" (the family's constructor literals — OpenZeppelin's family metadata is family-wide), `decimals` read from `NativeShieldedTokenFamily__decimals` (0) |
| Colors | one per type: `tokenType(domain, contractAddress)` |
| Access control | `Ownable_assertOnlyOwner()` on every emitting circuit and on `mint` |
| What to publish and expect | [`metadata.json`](metadata.json) |

## Add these lines

<!-- readme-diff from="contracts/without-metadata/MyTokenFamily.compact" to="contracts/MyTokenFamily.compact" -->
```diff
@@ -14,4 +14,5 @@
 import "@openzeppelin/compact-contracts/access/Ownable" prefix Ownable_;
 import "@openzeppelin/compact-contracts/token/NativeShieldedTokenFamily" prefix NativeShieldedTokenFamily_;
+import "@mip0018/compact/src/Mip0018" prefix Mip0018_;

 export { Either, ContractAddress, ZswapCoinPublicKey, ShieldedCoinInfo };
@@ -47,2 +48,30 @@
   return NativeShieldedTokenFamily__mint(domain, recipient, amount, nonce);
 }
+
+// MIP-0018 metadata (kind 1). Each domain is its own token identity with its own events: publish
+// once per domain (the same `domain` the mints use, so consumers derive each type's color).
+
+// Call for each domain, e.g. right after deployment. The family's literals, as passed to the
+// constructor; `decimals` is read from the family's state.
+export circuit publishMetadata(domain: Bytes<32>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_commonFields<11, 5>(
+    domain, Mip0018_KIND_SHIELDED(), "Acme Medals", "MEDAL", NativeShieldedTokenFamily__decimals));
+}
+
+// Rename one token type: a new 11-byte name and 5-byte symbol for `domain` only; the other types
+// keep their metadata (the family getters keep returning the constructor values).
+export circuit setMetadata(domain: Bytes<32>, newName: Bytes<11>, newSymbol: Bytes<5>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_payload2<4, 11, 6, 5>(
+    Mip0018_header(domain, Mip0018_KIND_SHIELDED()),
+    Mip0018_nameRecord<11>(newName),
+    Mip0018_symbolRecord<5>(newSymbol)));
+}
+
+// Withdraw one token type's metadata (a Null record for each key of `domain`, one event); the
+// other types are unchanged.
+export circuit withdrawMetadata(domain: Bytes<32>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_withdraw(domain, Mip0018_KIND_SHIELDED()));
+}
```

- **One event per type** — a payload describes one `(domainSep, kind)`; call `publishMetadata(domain)`
  once per type (any order; a type may be described before its first mint). The `domain` is a circuit
  argument, exactly like the family's `mint(domain, …)`: use the same 32 bytes, or the colors will not
  match.
- **Family-wide values, per-type identities** — OpenZeppelin's family keeps one `name`/`symbol`/
  `decimals` for all types (its "one brand" rule), so each type is published with the family values;
  consumers then group the types under one symbol (MIP "Symbol grouping": presentation only — a group
  never says its members are interchangeable). MIP-0018 can describe more than the getters do:
  `setMetadata(domain, …)` gives one type its own name and symbol (the getters stay family-wide).
- **Independent lifecycles** — `withdrawMetadata(domain)` deletes every key of that type only (one event, four Null records).

## Deploy and publish

1. Deploy `MyTokenFamily` with `name_ = "Acme Medals"`, `symbol_ = "MEDAL"`, `decimals_ = 0`,
   `initialOwner = left(<your Ownable account id>)`.
2. For each type: `publishMetadata(<domain>)` as the owner (one `Misc` event each).
3. Mint with `mint(domain, recipient, amount, nonce)`; it emits no metadata.

A consumer then shows three kind-1 identities, each with its own color, in one `MEDAL`
group (`metadata.json` → `expected`).

## Tests

```sh
docker/run.sh exec 'npx vitest run examples/openzeppelin/token-family'
```

[`test/token-family.test.ts`](test/token-family.test.ts), in compact-runtime 0.20.0 (no chain), with the
reference consumer (`@mip0018/consumer`):

| Test | Shows |
|---|---|
| exact values | every emitted event of every step, decoded with `@mip0018/codec`: header and each key and value equal `metadata.json` exactly (no zero padding, `decimals` 1 byte) |
| publish | `publishMetadata(domain)` emits one event under that `domain`, kind 1, payload = `metadata.json` |
| **colors** | for each type: minted coin color = Zswap output color = `tokenColor(domain)` = `rawTokenType(domain, contractAddress)` = the consumer's color for that identity; three distinct colors; each mint effect keyed by its `domain` |
| **independence** | after minting gold and silver and publishing all three: three identities, one `MEDAL` group. Withdrawing silver removes only silver (again: no change); renaming gold to "Gold Medals" / `GOLDM` moves only gold to its own group; republishing silver revives it with the family values — untouched types keep the same fields at the same chain positions after every step, and the state equals `metadata.json` |
| normal operation | `mint` emits no event, with and without metadata |
| access control | a non-owner cannot publish, rename, withdraw or mint (`Ownable: caller is not the owner`) |
| the diff | three more circuits, nothing else |

Circuit sizes: [`../README.md`](../README.md#costs).
