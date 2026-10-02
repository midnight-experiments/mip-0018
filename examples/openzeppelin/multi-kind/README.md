# examples/openzeppelin/multi-kind — one asset as kinds 1, 2 and 3

One contract represents one asset, "Acme Dollar", three ways at once: shielded coins
(OpenZeppelin `NativeShieldedToken`), unshielded UTXOs (the standard library's `mintUnshieldedToken`;
OpenZeppelin 0.4.0-alpha.5 has no unshielded module) and ledger balances (OpenZeppelin
`FungibleToken`), all under **one `domainSep`**, owned with `Ownable`. A user can hold all three.

MIP-0018 treats each representation as its **own token identity** — `(network, contractAddress,
domainSep, kind)` with kind 1, 2 or 3 — with its own events and lifecycle; consumers show them
together because they share the contract and the `symbol` ("Symbol grouping").

| | |
|---|---|
| Start from | [`contracts/without-metadata/MyMultiKindToken.compact`](contracts/without-metadata/MyMultiKindToken.compact) |
| Result | [`contracts/MyMultiKindToken.compact`](contracts/MyMultiKindToken.compact) |
| MIP `kind` | 1 (shielded coins), 2 (unshielded UTXOs), 3 (ledger balances) |
| `domainSep` | `NativeShieldedToken__domain` for all three (the unshielded mint uses it too; the ledger token reuses it) |
| Published | three events in one `publishMetadata()` call, each `name` "Acme Dollar", `symbol` "ACD", `decimals` 2 |
| Colors | kinds 1 and 2: the **same** color `tokenType(domainSep, contractAddress)`; kind 3: none |
| Access control | `Ownable_assertOnlyOwner()` on every emitting and minting circuit |
| What to publish and expect | [`metadata.json`](metadata.json) |

## Add these lines

<!-- readme-diff from="contracts/without-metadata/MyMultiKindToken.compact" to="contracts/MyMultiKindToken.compact" -->
```diff
@@ -18,4 +18,5 @@
 import "@openzeppelin/compact-contracts/token/NativeShieldedToken" prefix NativeShieldedToken_;
 import "@openzeppelin/compact-contracts/token/FungibleToken" prefix FungibleToken_;
+import "@mip0018/compact/src/Mip0018" prefix Mip0018_;

 export { Either, ContractAddress, ZswapCoinPublicKey, ShieldedCoinInfo, UserAddress };
@@ -56,2 +57,34 @@
   return FungibleToken_balanceOf(account);
 }
+
+// MIP-0018 metadata. Each representation is its own token identity (kind 1, 2, 3) with its own
+// event, all under the token's domain separator and with one symbol, so consumers show them as
+// one asset (MIP "Symbol grouping") while each keeps its own metadata.
+
+// Call right after deployment (a constructor cannot emit): three events in one transaction. The
+// same literals as the constructor's `name_` and `symbol_`; `decimals` from the token's state.
+export circuit publishMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_commonFields<11, 3>(
+    NativeShieldedToken__domain, Mip0018_KIND_SHIELDED(), "Acme Dollar", "ACD", NativeShieldedToken__decimals));
+  Mip0018_emitPayload(Mip0018_commonFields<11, 3>(
+    NativeShieldedToken__domain, Mip0018_KIND_UNSHIELDED(), "Acme Dollar", "ACD", NativeShieldedToken__decimals));
+  Mip0018_emitPayload(Mip0018_commonFields<11, 3>(
+    NativeShieldedToken__domain, Mip0018_KIND_LEDGER(), "Acme Dollar", "ACD", FungibleToken__decimals));
+}
+
+// Rename one representation (kind 1, 2 or 3): a new 11-byte name and 3-byte symbol. The other
+// representations keep their metadata; a new symbol moves only this one out of the group.
+export circuit setMetadata(kind: Uint<8>, newName: Bytes<11>, newSymbol: Bytes<3>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_payload2<4, 11, 6, 3>(
+    Mip0018_header(NativeShieldedToken__domain, kind),
+    Mip0018_nameRecord<11>(newName),
+    Mip0018_symbolRecord<3>(newSymbol)));
+}
+
+// Withdraw one representation's metadata (kind 1, 2 or 3); the others are unchanged.
+export circuit withdrawMetadata(kind: Uint<8>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_tombstone(NativeShieldedToken__domain, kind));
+}
```

- **One event per identity** — a payload describes exactly one `(domainSep, kind)`, so publishing the
  asset takes three events; one circuit emits all three in one transaction (k = 16). If that is too
  big for you, split it into `publishMetadata(kind)` (k = 15, three transactions).
- **One `domainSep`, one `symbol`** — that is what makes consumers group the three identities. They
  stay separate identities: each has its own fields, and an update to one changes no other.
- **`setMetadata(kind, …)` and `withdrawMetadata(kind)`** take the kind, so one representation can be
  renamed or withdrawn alone. A kind other than 1, 2 or 3 fails the module's `header()` assertion.
- **Same color for kinds 1 and 2** — both native mints use `tokenType(domainSep, contractAddress)`, so
  a shielded coin and an unshielded UTXO of this asset have the same 32-byte color; a wallet knows the
  kind from what it holds (MIP Lookup, shown by this example's tests).

## Deploy, mint and publish

1. Deploy `MyMultiKindToken` with `domainSep` (here `pad(32, "mip-0018:example:multi-kind")`),
   `name_ = "Acme Dollar"`, `symbol_ = "ACD"`, `decimals_ = 2`, `initialOwner = left(<your Ownable
   account id>)`.
2. Call `publishMetadata()` once: three `Misc` events (kinds 1, 2, 3), payloads in `metadata.json`.
3. Mint any representation (`mintShielded`, `mintUnshielded`, `mintLedger`); none emits metadata.

A consumer then shows three visible identities in one `ACD` group (`metadata.json` → `expected`).

## Tests

```sh
docker/run.sh exec 'npx vitest run examples/openzeppelin/multi-kind'
```

[`test/multi-kind.test.ts`](test/multi-kind.test.ts), in compact-runtime 0.20.0 (no chain), with the
reference consumer (`@mip0018/consumer`, MIP vectors S6 and S9 on a real contract):

| Test | Shows |
|---|---|
| exact values | every emitted event of every step, decoded with `@mip0018/codec`: header and each key and value equal `metadata.json` exactly (no zero padding, `decimals` 1 byte) |
| publish | one call, three events (kinds 1, 2, 3), one `domainSep`, payloads = `metadata.json` |
| **colors** | the shielded coin and the unshielded UTXO have the same color = `rawTokenType(domainSep, contractAddress)` = the color the consumer derives for kinds 1 and 2; kind 3 has none and its mint has no native effect |
| **grouping and independence** | after the steps: three identities, one `ACD` group. Then: renaming kind 3 to symbol `ACL` moves only kind 3 out of the group; renaming kind 1 changes only kind 1; withdrawing kind 2 hides only kind 2 (twice: no further change); republishing restores one group of three — the untouched identities keep the same fields at the same chain positions after every step, and the state equals `metadata.json` |
| two contracts | a second deployment with the same `domainSep` and symbol gives three more identities in a separate group, with a different color (groups never span contracts) |
| normal operation | the three mints and `transfer` emit no event, with and without metadata |
| bad kind | `setMetadata` / `withdrawMetadata` with kind 0, 4 or 255 fail (`MIP-0018: kind must be 1, 2 or 3`) |
| access control | a non-owner cannot publish, rename, withdraw or mint (`Ownable: caller is not the owner`) |
| the diff | three more circuits, nothing else |

Circuit sizes: [`../README.md`](../README.md#costs).
