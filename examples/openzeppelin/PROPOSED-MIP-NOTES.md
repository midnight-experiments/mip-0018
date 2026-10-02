# Proposed MIP-0018 notes from the OpenZeppelin examples (S3) — staging file

Staging file for the orchestrator: move these into the root [`MIP-PROPOSAL-NOTES.md`](../../MIP-PROPOSAL-NOTES.md)
as the next free numbers (N12 onward at the time of writing; the root file already has N1–N11), then
delete this file. Same format as the root file; the MIP text stays the authority meanwhile.

MIP text: [`midnightntwrk/midnight-improvement-proposals@b147c627e1bb15b5d15cc73cf30c2a36afd34dbb`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md).

---

## S3-a — Common fields: getter equality when the getters cannot change and the token is renamed

- **MIP section**: Common fields ("A token that also exposes MIP-0004, MIP-0011 or MIP-0014 getters SHOULD emit the same values those getters return") and Publishing ("… and for extraordinary updates, such as a rename").
- **Problem**: the MIP's own adoption targets (Implementation Plan step 4: OpenZeppelin `NativeShieldedToken`, `NativeShieldedTokenFamily`, `FungibleToken`) store `name` and `symbol` as `sealed` ledger fields: the getters can never change after deployment. Any MIP-0018 rename of such a token therefore emits values its getters do not return — the rename the Publishing section allows breaks the Common-fields SHOULD. A reader cannot tell which wins, and an issuer cannot both rename and conform.
- **Evidence**: `examples/openzeppelin/*/contracts/*.compact` (OpenZeppelin 0.4.0-alpha.5): `setMetadata` renames; the runtime tests show the event state after a rename while `name()` / `symbol()` keep the constructor values (`_name`/`_symbol` are `export sealed ledger … Opaque<"string">` in `NativeShieldedTokenCore` and `FungibleToken`). The equality itself cannot be checked in circuit (`Opaque<"string">` cannot be converted to bytes; findings F6).
- **Options** (for the authors):

  | Option | Text | Effect |
  |---|---|---|
  | (a) Getter equality at first publication | "… SHOULD emit the same values those getters return when it first publishes them. A later rename is the token's current metadata for consumers of this MIP, even where the getters cannot change." | Renames of OpenZeppelin tokens conform; wallets that also read getters know which wins |
  | (b) No renames for immutable getters | "A token whose getters cannot change SHOULD NOT rename through these events." | Keeps the SHOULD absolute; OpenZeppelin tokens can never rename |
  | (c) No change | — | The two sentences stay in tension |

- **Meanwhile**: the examples publish the constructor literals (getter-consistent) and document that a rename supersedes the `sealed` getters (`examples/openzeppelin/README.md`, "Renames do not change the getters").
- **Status**: NEEDS-DECISION (recommendation: (a))

## S3-b — Payload: a fixed-size field must be exactly as long as its key or value

- **MIP section**: Payload ("Keys and values are exact byte strings … zero bytes inside a key or value are significant" and "a Compact emitter builds each payload from fixed-size fields (for example `Uint<8>` lengths and `Bytes<K>` keys)").
- **Problem**: the natural Compact mistake — a `Bytes<K>` wider than the text it carries — appends zero bytes that become part of the key or value (`"AGL"` in a `Bytes<4>` is `"AGL\0"`). The result is still a valid payload (NUL is valid UTF-8), so consumers accept it and show a different symbol, or treat a padded key as an unknown key. Nothing in the payload rules catches it; only the emitter can prevent it. (The same pitfall was found independently by the scripts slice; merge with that note if one exists.)
- **Evidence**: `examples/openzeppelin/test/exact-values.test.ts` — with this repository's module a literal of the wrong length does not compile, and compact-runtime 0.20.0 refuses a too-short argument (`expected value of type Bytes<9>`), but a rename argument zero-padded to the circuit's size is emitted as `"Short\0\0\0\0"` and accepted by the reference codec; every example now decodes every emitted event and compares each value with its `metadata.json` exactly.
- **Proposed text** (informative, after the Compact sentence of the Payload section): "Each fixed-size field must be exactly as long as the key or value it carries: a shorter value padded with zero bytes is a different value (for example `"AGL"` sent as a `Bytes<4>` is `"AGL\0"`), and consumers accept it as such."
- **Meanwhile**: the module's typed builders take the sizes as generic arguments checked by the compiler; the OpenZeppelin README says "never pad a value with zeros"; tests compare every emitted value exactly.
- **Status**: PROPOSED (informative)

## S3-c — Implementation Plan step 4: say where kind 2 comes from

- **MIP section**: Implementation Plan, step 4 ("Propose the module to OpenZeppelin Compact Contracts as an optional extension of `NativeShieldedToken`, `NativeShieldedTokenFamily` and `FungibleToken`").
- **Problem**: the list covers kinds 1 and 3 only. OpenZeppelin Compact Contracts 0.4.0-alpha.5 has no native unshielded (MIP-0014, kind 2) module on `main` (earlier `NativeUnshieldedToken` drafts exist only on stale branches for an older ledger), so an OpenZeppelin user has no base for a kind-2 token, and readers may assume kind 2 is not meant to be covered.
- **Evidence**: `examples/openzeppelin/native-unshielded` and `multi-kind` use the standard library's `mintUnshieldedToken` with OpenZeppelin `Ownable`; the module works for kind 2 unchanged (runtime tests: the minted UTXO's color equals `tokenType(domainSep, contractAddress)` and the consumer's color). All three listed modules take the extension unchanged (compile with Compact 0.35.0 + ZKIR v3 against 0.4.0-alpha.5, no compiler message).
- **Proposed text**: "… as an optional extension of `NativeShieldedToken`, `NativeShieldedTokenFamily` and `FungibleToken`, and of a native unshielded token module once the library has one (until then, kind 2 tokens call `mintUnshieldedToken` directly)."
- **Meanwhile**: documented in `examples/openzeppelin/native-unshielded/README.md`. Nothing is proposed to OpenZeppelin from this repository (owner decision Q6).
- **Status**: PROPOSED (editorial)

## Evidence to add to N3 (kinds 1 and 2 share one color)

N3 waits for "this repository's own Stagenet case". Runtime evidence now exists:
`examples/openzeppelin/multi-kind/test/multi-kind.test.ts` — one contract mints a shielded coin and an
unshielded UTXO under one `domainSep`; both carry the same 32-byte color, equal to `rawTokenType(domainSep,
contractAddress)` and to the color the reference consumer derives for the kind-1 and kind-2 identities. The
Stagenet case for the same contract (S5 case C04) can replace or complement it.

## Considered — no change proposed

| Topic | Decision |
|---|---|
| OpenZeppelin's `NativeShieldedTokenFamily` keeps one family-wide name/symbol ("one brand"); published getter-consistently, all types of a family fall into one symbol group | The MIP already says grouping is presentation only and does not make members interchangeable; an issuer who wants separate groups gives each type its own symbol (`setMetadata(domain, …)` in `examples/openzeppelin/token-family`). No change. |
| One asset in three kinds needs three events (one per identity): one circuit emitting all three costs k = 16 (≈ 57,000 rows) vs k = 15 per single-event call | By design (each kind has its own lifecycle, MIP Rationale "A `kind` byte"). Documented in `examples/openzeppelin/multi-kind`. No change. |
| OpenZeppelin claims no MIP standard, so the examples publish no `standards` (questions Q25) | `standards` is self-declared by design. No change. |
