# examples/openzeppelin/native-shielded — a native shielded token (kind 1)

An OpenZeppelin `NativeShieldedToken` (Zswap coins of one token type, MIP-0011 shape) owned with
`Ownable`, from [OpenZeppelin Compact Contracts 0.4.0-alpha.5](https://github.com/OpenZeppelin/compact-contracts/tree/v0.4.0-alpha.5),
gains MIP-0018 metadata. Wallets hold this token as shielded coins whose color is
`tokenType(domainSep, contractAddress)`; the metadata event names that same `domainSep`, so a wallet
that holds a coin can find the token's name, symbol and decimals.

| | |
|---|---|
| Start from | [`contracts/without-metadata/MyShieldedToken.compact`](contracts/without-metadata/MyShieldedToken.compact) |
| Result | [`contracts/MyShieldedToken.compact`](contracts/MyShieldedToken.compact) |
| MIP `kind` | 1 (native shielded: has a color) |
| `domainSep` | the token's own domain separator, read from `NativeShieldedToken__domain` (set once by `initialize`, used by every mint) |
| Published | `name` "Acme Shield", `symbol` "ASHD" (the same literals the deployer passes to `initialize`), `decimals` read from `NativeShieldedToken__decimals` |
| Access control | `Ownable_assertOnlyOwner()` on every emitting circuit (and on `mint` / `burn`, as OpenZeppelin recommends) |
| What to publish and expect | [`metadata.json`](metadata.json) |

## Add these lines

<!-- readme-diff from="contracts/without-metadata/MyShieldedToken.compact" to="contracts/MyShieldedToken.compact" -->
```diff
@@ -13,4 +13,5 @@
 import "@openzeppelin/compact-contracts/access/Ownable" prefix Ownable_;
 import "@openzeppelin/compact-contracts/token/NativeShieldedToken" prefix NativeShieldedToken_;
+import "@mip0018/compact/src/Mip0018" prefix Mip0018_;

 export { Either, ContractAddress, ZswapCoinPublicKey, ShieldedCoinInfo, Maybe };
@@ -52,2 +53,29 @@
   return NativeShieldedToken__burn(coin, amount, refundTo);
 }
+
+// MIP-0018 metadata (kind 1). The `domainSep` is the token's own domain separator, read from
+// `NativeShieldedToken__domain`: the one every mint uses, so a consumer derives the minted color.
+
+// Call right after deployment (a constructor cannot emit). The same literals as the
+// constructor's `name_` and `symbol_`; `decimals` is read from the token's own state.
+export circuit publishMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_commonFields<11, 4>(
+    NativeShieldedToken__domain, Mip0018_KIND_SHIELDED(), "Acme Shield", "ASHD", NativeShieldedToken__decimals));
+}
+
+// Rename (an extraordinary update): a new 11-byte name and 4-byte symbol; other fields keep
+// their values. The sizes are part of the circuit; values must be valid UTF-8.
+export circuit setMetadata(newName: Bytes<11>, newSymbol: Bytes<4>): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_payload2<4, 11, 6, 4>(
+    Mip0018_header(NativeShieldedToken__domain, Mip0018_KIND_SHIELDED()),
+    Mip0018_nameRecord<11>(newName),
+    Mip0018_symbolRecord<4>(newSymbol)));
+}
+
+// Withdraw (tombstone): consumers hide the token and clear all its metadata.
+export circuit withdrawMetadata(): [] {
+  Ownable_assertOnlyOwner();
+  Mip0018_emitPayload(Mip0018_tombstone(NativeShieldedToken__domain, Mip0018_KIND_SHIELDED()));
+}
```

- **`NativeShieldedToken__domain`** — `NativeShieldedToken` stores its domain separator as an
  exported `sealed ledger _domain`, which the importing contract reads with the module prefix. Using
  it (instead of a literal) guarantees the event names the `domainSep` every `mint` uses, so the color
  a consumer derives, `tokenType(domainSep, contractAddress)`, is exactly the color of the coins
  (MIP "Token identity and authority": "A color MUST always be computed this way, never read from a
  value"). Reading state makes the circuit k = 15 instead of 13.
- **Same literals, `decimals` from state, fixed sizes, no `standards`** — as in
  [`fungible-token`](../fungible-token/README.md): OpenZeppelin's `name`/`symbol` are
  `Opaque<"string">`; pass the same strings to the constructor; `setMetadata` takes an 11-byte name
  and a 4-byte symbol.

## Deploy, mint and publish

1. Deploy `MyShieldedToken` with `domainSep` (here `pad(32, "mip-0018:example:shielded")`),
   `name_ = "Acme Shield"`, `symbol_ = "ASHD"`, `decimals_ = 6` and `initialOwner = left(<your
   Ownable account id>)`.
2. Call `publishMetadata()` as the owner (one `Misc` event; payload in `metadata.json`).
3. Mint as usual: `mint(recipient, amount, nonce)` creates a coin of color
   `tokenType(domainSep, contractAddress)` and emits no metadata. The order of 2 and 3 does not
   matter to a consumer: metadata belongs to the identity, not to a mint.

A wallet holding a coin of that color finds `(contractAddress, domainSep)` through a mint index
(`mip0018 index` / `lookup`) and then this identity: kind 1, visible, `name` "Acme Shield",
`symbol` "ASHD", `decimals` 6, colored (`metadata.json` → `expected`).

## Tests

```sh
docker/run.sh exec 'npx vitest run examples/openzeppelin/native-shielded'
```

[`test/native-shielded.test.ts`](test/native-shielded.test.ts), in compact-runtime 0.20.0 (no chain):

| Test | Shows |
|---|---|
| metadata.json payloads | every expected payload equals the reference encoder |
| exact values | every emitted event of every step, decoded with `@mip0018/codec`: header and each key and value equal `metadata.json` exactly (no zero padding, `decimals` 1 byte) |
| publish | payload = `metadata.json`; header `domainSep` = the constructor's `domainSep` (`NativeShieldedToken__domain`), kind 1; the constructor literals |
| **color** | `rawTokenType(domainSep, contractAddress)` from the official runtime = the color of the coin `mint` returns = the color of its Zswap output = `tokenColor()` = the color the reference consumer derives for the kind-1 identity; the shielded mint effect is keyed by the event's `domainSep` |
| steps and lifecycle | mint → publish → rename → withdraw → withdraw again → revive: bytes, mint effects and consumer state equal `metadata.json` |
| normal operation | `mint` and `burn` (a holder's coin, 400 of 1,000 burnt, 600 refunded) emit no event, with and without metadata |
| access control | a non-owner `publishMetadata`, `setMetadata`, `withdrawMetadata`, `mint` fails (`Ownable: caller is not the owner`) |
| the diff | three more circuits, nothing else |

Circuit sizes: [`../README.md`](../README.md#costs).
