# examples/openzeppelin/native-unshielded — a native unshielded token (kind 2)

A native unshielded token (unshielded UTXOs, MIP-0014 shape) owned with OpenZeppelin `Ownable`
gains MIP-0018 metadata.

**OpenZeppelin Compact Contracts 0.4.0-alpha.5 has no native unshielded token module** (none on
`main`; earlier `NativeUnshieldedToken` drafts exist only on stale experimental branches for an older
ledger). So the token part of this example uses the **Compact standard library directly**:
`mintUnshieldedToken(_domain, amount, recipient)`, written in the style of OpenZeppelin's
`NativeShieldedToken` (one token type; domain separator, name, symbol and decimals fixed at
construction). Access control is still OpenZeppelin `Ownable`.

| | |
|---|---|
| Start from | [`contracts/without-metadata/MyUnshieldedToken.compact`](contracts/without-metadata/MyUnshieldedToken.compact) |
| Result | [`contracts/MyUnshieldedToken.compact`](contracts/MyUnshieldedToken.compact) |
| MIP `kind` | 2 (native unshielded: has a color) |
| `domainSep` | the token's own `_domain` (set by the constructor, used by every `mintUnshieldedToken`) |
| Published | `name` "Acme Public", `symbol` "APUB" (the same literals the deployer passes to the constructor), `decimals` read from `_decimals` |
| Access control | `Ownable_assertOnlyOwner()` on every emitting circuit and on `mint` |
| What to publish and expect | [`metadata.json`](metadata.json) |

## Add these lines

<!-- readme-diff from="contracts/without-metadata/MyUnshieldedToken.compact" to="contracts/MyUnshieldedToken.compact" -->
```diff
@@ -16,4 +16,5 @@
 import CompactStandardLibrary;
 import "@openzeppelin/compact-contracts/access/Ownable" prefix Ownable_;
+import "@mip0018/compact/src/Mip0018" prefix Mip0018_;

 export { Either, ContractAddress, UserAddress };
@@ -58,2 +59,28 @@
   return mintUnshieldedToken(_domain, disclose(amount), right<ContractAddress, UserAddress>(disclose(recipient)));
 }
+
+// MIP-0018 metadata (kind 2). The `domainSep` is `_domain`, the one every mint uses, so a consumer
+// derives the color of the minted UTXOs.
+
+// Call right after deployment (a constructor cannot emit). The same literals as the
+// constructor's `name_` and `symbol_`; `decimals` is read from the token's own state.
+export circuit publishMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_commonFields<11, 4>(_domain, Mip0018_KIND_UNSHIELDED(), "Acme Public", "APUB", _decimals));
+}
+
+// Rename (an extraordinary update): a new 11-byte name and 4-byte symbol; other fields keep
+// their values. The sizes are part of the circuit; values must be valid UTF-8.
+export circuit setMetadata(newName: Bytes<11>, newSymbol: Bytes<4>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_payload2<4, 11, 6, 4>(
+    Mip0018_header(_domain, Mip0018_KIND_UNSHIELDED()),
+    Mip0018_nameRecord<11>(newName),
+    Mip0018_symbolRecord<4>(newSymbol)));
+}
+
+// Withdraw (tombstone): consumers hide the token and clear all its metadata.
+export circuit withdrawMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_tombstone(_domain, Mip0018_KIND_UNSHIELDED()));
+}
```

- **`_domain`** — the value every `mintUnshieldedToken` call uses, so the color a consumer derives,
  `tokenType(domainSep, contractAddress)`, is exactly the color of the UTXOs the holder receives.
- **Same color as a shielded mint** — a shielded mint under the same `domainSep` by the same contract
  has the same color; the kind comes from what the user holds (an unshielded UTXO → kind 2). See
  [`multi-kind`](../multi-kind/README.md) and `MIP-PROPOSAL-NOTES.md` N3.
- **Same literals, `decimals` from state, fixed sizes, no `standards`** — as in
  [`fungible-token`](../fungible-token/README.md). This contract stores `name`/`symbol` as
  `Opaque<"string">` like OpenZeppelin's modules do, so the circuit repeats them as literals.

## Deploy, mint and publish

1. Deploy `MyUnshieldedToken` with `domainSep` (here `pad(32, "mip-0018:example:unshielded")`),
   `name_ = "Acme Public"`, `symbol_ = "APUB"`, `decimals_ = 6`, `initialOwner = left(<your Ownable
   account id>)`.
2. Call `publishMetadata()` as the owner.
3. `mint(recipient, amount)` sends a new unshielded UTXO of color `tokenType(domainSep,
   contractAddress)` to the recipient's user address; it emits no metadata.

The holder's wallet sees the UTXO's color; a mint index resolves it to `(contractAddress, domainSep)`
and kind 2 (an unshielded UTXO), whose metadata is this event (`metadata.json` → `expected`).

## Tests

```sh
docker/run.sh exec 'npx vitest run examples/openzeppelin/native-unshielded'
```

[`test/native-unshielded.test.ts`](test/native-unshielded.test.ts), in compact-runtime 0.20.0 (no chain):

| Test | Shows |
|---|---|
| metadata.json payloads | every expected payload equals the reference encoder |
| exact values | every emitted event of every step, decoded with `@mip0018/codec`: header and each key and value equal `metadata.json` exactly (no zero padding, `decimals` 1 byte) |
| publish | payload = `metadata.json`; header `domainSep` = `_domain`, kind 2; the constructor literals; the contract's `_domain` / `_decimals` state holds the same values |
| **color** | `rawTokenType(domainSep, contractAddress)` = the color `mintUnshieldedToken` returns = the color of the UTXO the transaction creates for the holder (claimed unshielded spend) = `tokenColor()` = the color the reference consumer derives for the kind-2 identity; the unshielded mint effect is keyed by the event's `domainSep` |
| steps and lifecycle | mint → publish → rename → withdraw → withdraw again → revive: bytes, mint effects and consumer state equal `metadata.json` |
| normal operation | `mint` emits no event, with and without metadata |
| access control | a non-owner `publishMetadata`, `setMetadata`, `withdrawMetadata`, `mint` fails (`Ownable: caller is not the owner`) |
| the diff | three more circuits, nothing else |

Circuit sizes: [`../README.md`](../README.md#costs).
