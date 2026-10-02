# MIP-0018 proposal notes

Things this reference implementation found that should be **defined or updated upstream** in MIP-0018.
They are notes for the MIP authors, not changes made here: the MIP text stays the authority, and every behaviour in this repository follows the pinned text below until a note is accepted upstream.

| | |
|---|---|
| MIP text these notes refer to | [`midnightntwrk/midnight-improvement-proposals@b147c627e1bb15b5d15cc73cf30c2a36afd34dbb` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md) (SHA-256 `9ffba7e6a3123cd6683e5a779ac3b73c8a31a9724367cd98ee120be78720d842`) |
| How to add a note | One section per note: MIP section, problem, evidence, proposed change, what this repository does meanwhile, status. Append; never delete — change the status instead. |
| Statuses | `NEEDS-DECISION` (options below, the authors choose) · `PROPOSED` (concrete text suggested) · `ACCEPTED-UPSTREAM` (merged into the MIP; link the commit) · `WITHDRAWN` |

---

## N1 — Define a valid URI (`valType` 4) the way ERC-721 does: RFC 3986 `URI`

- **MIP section**: Value types (`valType` 4: "A UTF-8 absolute URI (RFC 3986)").
- **Problem**: the sentence admits several readings. RFC 3986 `absolute-URI` has no fragment while `URI` does; RFC 3986 is ASCII-only while the MIP says UTF-8 (which suggests RFC 3987 IRIs). Because a value that breaks its type's rule rejects the **whole event**, two consumers that read it differently disagree on every record of that event.
- **Evidence**: 26 realistic values checked against 9 validators (WHATWG `URL`, fast-uri, uri-js, Python `urllib.parse`, `rfc3986`, `rfc3987`, a strict RFC 3986 grammar). 15 values get the same verdict everywhere; 11 split the libraries: a fragment (under the `absolute-URI` reading), non-ASCII host/path/query, a space, a backslash, an empty authority, an out-of-range port, a leading space, a bad percent-escape. Two independent strict-grammar validators agree on all 26. Data and harnesses: `vectors/informative/uri/` (added with the vectors).
- **Decision for this repository**: follow ERC-721, whose `tokenURI` says "URIs are defined in RFC 3986" — i.e. the RFC 3986 `URI` rule: a scheme is required, a fragment is allowed, characters are ASCII (non-ASCII characters percent-encoded, host names in their ASCII form). Relative references are rejected (as vector R5 already requires).
- **Proposed text**: "| 4 | URI | A URI as defined in RFC 3986 (the `URI` rule of §3, as used by ERC-721 `tokenURI`): a scheme is required and a fragment is allowed. All characters are ASCII; characters outside ASCII MUST be percent-encoded, and host names converted to their ASCII form, before emitting. |"
- **Alternatives considered**: RFC 3987 IRI (matches "UTF-8" but few validators); keep `absolute-URI` (rejects fragments every library accepts); "parses as a WHATWG URL" (lenient and normalising, disagrees with RFC libraries); a minimal "scheme + no space/control bytes" rule (simple, but accepts strings no parser accepts).
- **Meanwhile**: the reference consumer enforces the RFC 3986 `URI` rule with a strict grammar; the 26 cases are informative vectors with that verdict.
- **Status**: PROPOSED

## N2 — Say that raw ledger log data has its trailing zero bytes removed

- **MIP section**: Payload ("every byte after the last record, up to byte 256, is zero") and Consuming ("How consumers obtain events is defined by MIP-0002").
- **Problem**: the ledger and the Compact runtime store a logged `Misc` item (`name ‖ payload`, 288 bytes) **without its trailing zero bytes**. A consumer that reads events from raw transactions, node data or the runtime (instead of the indexer, whose `payload` is already 256 bytes) sees a shorter byte string and may reject a valid payload as truncated, or mis-split `name` and `payload`.
- **Evidence**: ledger source (log items are stored without trailing zeros) and the Compact runtime (`CircuitResults.context.events` returns the shortened data); the indexer's `MiscContractEvent.payload` is padded to 256. Confirmed on Stagenet case S0-SPIKE (`deployments/stagenet/`, record `test-contracts/toolchain-spike/records/stagenet.json`, event id 53254): the event's `raw` ledger bytes carry only 127 data bytes (the 32-byte name and the 95 content bytes of the A1 payload) followed directly by the next field — the 161 padding zeros are not there — while the indexer's `payload` field is the full 256 bytes.
- **Further evidence (Stagenet cases, 2026-10-02)**: the same on every emitter shape of the matrix — case C10's A1 event (id 53557, [`deployments/stagenet/cases/C10`](deployments/stagenet/cases/C10/README.md)) carries 127 item bytes in its ledger `raw`; raw-emitter vector A2a (C07, event 53498) 286 of 288 (its last two bytes are zero); A2b (C07, event 53504), whose last payload byte is non-zero, carries all 288. The indexer's `name`/`payload` fields are zero-extended in every case, and `mip0018 verify` matched each indexed event with the zero-extended `log` op of the raw transaction (31 transactions, `observed-verify-*.json`).
- **Proposed text** (Consuming, or MIP-0002 if it belongs there): "Some sources return a `Misc` item's 288 data bytes without trailing zero bytes. Consumers MUST zero-extend the data to 288 bytes before taking `name` (bytes 0–31) and `payload` (bytes 32–287)."
- **Meanwhile**: the reference reader zero-extends every raw item to 288 bytes.
- **Status**: PROPOSED

## N3 — State that kinds 1 and 2 share one color under the same `domainSep`

- **MIP section**: Token identity and authority — Lookup.
- **Problem**: the MIP derives both native kinds' color with one formula but never says so explicitly; readers may expect two colors and build a table keyed by color alone.
- **Evidence**: one formula in the Compact standard library (`tokenType`) and in the ledger, with no kind input; runtime test `examples/openzeppelin/multi-kind/test/multi-kind.test.ts` — one contract mints a shielded coin and an unshielded UTXO under one `domainSep`, both carry the same 32-byte color, equal to `rawTokenType(domainSep, contractAddress)` and to the color the reference consumer derives for the kind-1 and kind-2 identities. **Stagenet (case [C04](deployments/stagenet/cases/C04/README.md), 2026-10-02)**: contract `86acf80f…570f` minted 100,000 shielded (block 714643) and 100,000 unshielded (block 714649) under `pad(32, "mip-0018:example:multi-kind")`; wallet 1 holds both under the ONE color `04239924…bc16` = `tokenType(domainSep, contract)` (`wallet-status.json`, from the wallet SDK), `list` gives the kind-1 and kind-2 identities that same color, and the mint scanner records one color entry with both kinds (case [IDX](deployments/stagenet/cases/IDX/README.md), lookups `lookup-C04-shielded.json` / `lookup-C04-unshielded.json`).
- **Further evidence (examples and CLI)**: on the local chain the multi-kind example's shielded and unshielded mints under one `domainSep` resolve, through the mint scanner, to one color entry carrying both kinds (`deployments/stagenet/cases/IDX`, steps `lookup-C04-shielded` / `lookup-C04-unshielded`; local run in the S4 plan), and the wallet SDK itself lists that one color among both its shielded and its unshielded balances (`wallet status`).
- **Proposed text** (informative, after "A color held by a user resolves …"): "A shielded and an unshielded mint with the same `domainSep` have the same color; the kind is given by what the user holds (a shielded coin → kind 1, an unshielded UTXO → kind 2), not by the color."
- **Meanwhile**: the lookup table records which kinds were minted under each color.
- **Status**: PROPOSED (editorial)

## N4 — Dependencies: state the toolchain as a minimum

- **MIP section**: Implementation — Dependencies ("Compact 0.34.0 / language 0.26.0 / runtime 0.19.0, Midnight ledger v9").
- **Problem**: read literally it pins one compiler; Compact 0.35.0 (language 0.27.0, runtime 0.20.0, same ledger target) is already released.
- **Proposed text**: "MIP-0002 `Misc` events: Compact 0.34.0 or later (language 0.26.0, runtime 0.19.0 or later), Midnight ledger v9."
- **Evidence**: this repository emits with Compact 0.35.0 (language 0.27.0, runtime 0.20.0) and `--feature-zkir-v3`; the emitted event equals A1 byte-for-byte on the local stack and on Stagenet (case S0-SPIKE, and the Stagenet cases [C06](deployments/stagenet/cases/C06/README.md) and [C10](deployments/stagenet/cases/C10/README.md), whose `publishMetadata()` events are Appendix A byte-for-byte).
- **Meanwhile**: the repository states the minimum and the exact versions it is built and tested with (`toolchain.json`).
- **Status**: PROPOSED (editorial)

## N5 — Existing contracts: the inserted verifier key must use the key version of the circuit's proving system

- **MIP section**: Backwards Compatibility Assessment — Existing contracts (step 2: "Add its verifier key with a `VerifierKeyInsert` maintenance update").
- **Problem**: on ledger v9 a contract operation holds verifier keys in two versioned slots: `v3` for circuits compiled to ZKIR v2 (the Compact default) and `v4` for circuits compiled with `--feature-zkir-v3`. A `VerifierKeyInsert`/`VerifierKeyRemove` must name the slot that matches the circuit; a mismatch is included on chain but its fallible segment fails, so the issuer pays a fee and nothing changes. The step reads as if any `VerifierKeyInsert` works, and the current SDK path makes the mismatch easy: midnight-js 5.0.0-rc.2 / compact-js 3.0.0-rc.3 always build `v3` maintenance updates.
- **Evidence**: local stack, this repository's S0 spike: midnight-js `removeVerifierKey()` of a ZKIR-v3 `publishMetadata` → `FailFallible`, key still present; the same `MaintenanceUpdate` with `VerifierKeyRemove(publishMetadata, v4)` → `SucceedEntirely`, key gone; the same `v4` removal on Stagenet (case S0-SPIKE, block 710814; case [C10](deployments/stagenet/cases/C10/README.md), block 715183, 0.039 DUST, after which the circuit has no key and a call is refused). Ledger: `ContractOperationVersion::{V3, V4}`, `ContractOperationVersionedVerifierKey::{V3, V4}`.
- **Further evidence**: local run of this template (2026-10-02) — `VerifierKeyInsert(publishMetadata, v4)` of a Compact 0.35.0 `--feature-zkir-v3` circuit into a deployed contract whose original circuit also has a `v4` key: `SUCCESS` (≈ 0.59 DUST), counter 0 → 1, ledger data unchanged; then the call through midnight-js `findDeployedContract` with the upgrade-only build is proven, accepted (≈ 0.16 DUST) and emits the expected event bound to the original address (README "Local run").
- **Stagenet evidence (case [U1](deployments/stagenet/cases/U1/README.md), 2026-10-02)**: `VerifierKeyInsert(publishMetadata, v4)` of the same Compact 0.35.0 ZKIR-v3 key into a `LegacyToken` deployed without it (`11010832…d63b`): `SUCCESS` in block 715428 (0.911 DUST), entry points `{mint}` → `{mint, publishMetadata}`, mint key and ledger data unchanged, authority counter 0 → 1; the call through the upgrade-only build (block 715433) emits the expected event bound to the original address, whose identity color equals the color of the coins minted before the insert.
- **Proposed text** (informative, after step 2): "The verifier key is inserted at the key version of the circuit's proving system (on ledger v9: `v3` for ZKIR v2 circuits, `v4` for ZKIR v3 circuits). Check that the tool building the maintenance update supports that version."
- **Meanwhile**: the upgrade template (S6) and the create-and-destroy example build the maintenance update with the ledger API and an explicit version (`test-contracts/toolchain-spike/src/lib/maintenance.ts`).
- **Status**: PROPOSED (informative)

## N6 — `standards`: say that the identifier rule is a byte rule (other Unicode spaces and controls are allowed)

- **MIP section**: Common fields — `standards` ("An identifier is non-empty and contains no spaces or control characters (no byte in `0x00`–`0x20` or `0x7f`).").
- **Problem**: the words "spaces or control characters" read like Unicode categories, while the parenthesis defines a byte rule. They differ for valid UTF-8 identifiers that contain, for example, U+00A0 (no-break space, bytes `c2 a0`) or U+0085 (C1 control NEL, bytes `c2 85`): no byte is in `0x00`–`0x20`/`0x7f`, so the byte rule accepts them, but a consumer that checks Unicode whitespace/control categories marks the whole field unusable. A malformed `standards` is unusable, not empty, so the two consumers then disagree on which standards a token claims.
- **Evidence**: informative vectors `vectors/informative/state/INF-STD-6.json` (U+00A0) and `INF-STD-7.json` (U+0085), both usable under the byte rule; the reference consumer implements the byte rule.
- **Proposed text**: "An identifier is non-empty and contains no byte in `0x00`–`0x20` or `0x7f` (ASCII space and control characters). Other characters, including non-ASCII spaces and controls, are allowed; identifiers SHOULD use printable ASCII."
- **Meanwhile**: the reference consumer applies the byte rule exactly as the parenthesis states; the two vectors are informative.
- **Status**: PROPOSED (editorial)

## N7 — Testing: say which consumers S8 (display) and S9 (symbol grouping) apply to

- **MIP section**: Testing ("These vectors are normative") and Path to Active ("At least two independent consumers … pass every vector"), versus Common fields (`decimals` meaning: "a raw amount is shown as `amount / 10^decimals`") and Symbol grouping ("Indexers SHOULD group …").
- **Problem**: S9 tests a SHOULD (grouping) and S8 tests presentation. A conforming consumer that does not group symbols (allowed by "SHOULD") or does not display amounts (for example an indexer that only serves raw fields) cannot "pass every vector", although it breaks no MUST. Whether such a consumer counts towards the acceptance criterion is unclear.
- **Evidence**: this repository's runner reports S8 and S9 like every other normative vector (`vectors/state/S8.json`, `S9a`–`S9d`); a consumer without grouping fails S9a–S9d only.
- **Proposed text** (Testing, before the state rules): "S8 applies to consumers that display amounts and S9 to consumers that group symbols; a consumer that does neither passes the other vectors."
- **Meanwhile**: the vectors keep S8 and S9 normative as the MIP says; the runner's per-test-id summary lets a consumer show exactly which of these it does not implement.
- **Status**: PROPOSED (editorial)

## N8 — Publishing: name "removed after use" as a third way to protect an emitting circuit

- **MIP section**: Publishing ("Who may call an emitting circuit is the contract's choice. Anyone who can call it can rename or withdraw the token, so it SHOULD be access-controlled or publish-once.").
- **Problem**: Midnight offers a third protection that needs no guard in the circuit: the contract's maintenance authority removes the emitting circuit's verifier key (`VerifierKeyRemove`) right after the deployer's first call, so nobody can call it again. It is cheaper than an owner check and simpler than a publish-once flag, and the owner of this reference chose it for the minimal example. It is only safe when the circuit's payload is **constant**: until the key is removed, anyone holding the compiled artefacts can call the circuit, and with runtime parameters they could publish anything (with a constant payload they can only re-emit the same values). The MIP's sentence does not mention it, and does not warn that an unguarded circuit with parameters is unsafe even briefly.
- **Evidence**: `examples/minimal/contracts/CreateAndDestroy.compact` — runtime tests (`examples/minimal/test/minimal.test.ts`: any caller re-emits exactly the A1 bytes before removal) and an end-to-end run on the local chain (`examples/minimal/scripts/create-and-destroy.ts`, 2026-10-01: deploy → `publishMetadata()` → one `Misc` event = A1 → `VerifierKeyRemove(publishMetadata, v4)` `SucceedEntirely` → a second call is refused, `Operation 'publishMetadata' is undefined`, still one event; `transfer` keeps its key). Stagenet: case S0-SPIKE (removal in block 710814) and case [C10](deployments/stagenet/cases/C10/README.md) (2026-10-02: the unguarded constant `publishMetadata()` emitted Appendix A in block 715177, its key was removed in block 715183, and a later call is refused before submission — "has no verifier key"; operations left: `transfer`). The deployed operation holds only the verifier key (1,353-byte key → 1,362-byte operation), not the circuit's ZKIR, so callers need the artefacts — which DApps ship. The removal must use the `v4` key slot for ZKIR v3 circuits (note N5).
- **Proposed text** (Publishing, replacing the third bullet): "Who may call an emitting circuit is the contract's choice. Anyone who can call it can rename or withdraw the token, so it SHOULD be access-controlled, publish-once, or removed after use (for example, a `publishMetadata()` whose payload is constant, whose verifier key the maintenance authority removes right after the deployer's call). An emitting circuit that is not access-controlled SHOULD NOT take the metadata as parameters."
- **Meanwhile**: `packages/compact/README.md` documents the three patterns with these caveats; `examples/minimal` implements all three.
- **Status**: PROPOSED

## N9 — Payload: do not tie the Compact construction to `serialize` of non-event types

- **MIP section**: Payload ("Compact has no runtime-sized byte strings, so a Compact emitter builds each payload from fixed-size fields (for example `Uint<8>` lengths and `Bytes<K>` keys), using the serialization the Compact compiler provides for those types.").
- **Problem**: the natural reading is `serialize<[header, records…], 256>(…)`. Compact 0.34.0 and 0.35.0 accept that for tuples and structs, but their standard-library documentation says `serialize` "can only be instantiated for an event type and its canonical serialized size" (`doc/api/CompactStandardLibrary/exports.md`, tag `compactc-v0.35.0`). If a later compiler enforces its documentation, the MIP's suggested method stops compiling. The same bytes can be built without `serialize`, by concatenating fixed-size fields with `Bytes[...]` spreads and a zero tail; both are checked at compile time.
- **Evidence**: `packages/compact` builds the payload both ways (`Mip0018.compact` with `serialize`, `Mip0018Pure.compact` with spreads). Executed in compact-runtime 0.20.0 they emit identical bytes, equal to the vectors A1–A5 and S1 and to the reference encoder for 729 generated payloads (every value size 1–219, multi-record shapes; `test/equivalence.test.ts`). Size errors are compile errors in both (`test/compile-fail.test.ts`). Cost: identical for constant payloads (k = 6); with runtime values `serialize` is cheaper (25,857 vs 39,207 rows for the four common fields, `docs/costs.md`).
- **Proposed text**: "… so a Compact emitter builds each payload from fixed-size fields (for example `Uint<8>` lengths and `Bytes<K>` keys), concatenated in order and zero-padded to 256 bytes — for example with the serialization the Compact compiler provides for those types, or with byte-vector concatenation — so that every length is checked at compile time."
- **Meanwhile**: the default module uses `serialize` (owner decision Q3: "ideally we can serialize with Compact"); the pure-circuit module is the fallback, and a compile test would catch a compiler that restricts `serialize`.
- **Status**: PROPOSED (informative)

## N10 — Lookup: count only mints that took effect, read from the transaction's effects

- **MIP section**: Token identity and authority → Lookup ("indexers record the contract address and `domainSep` of
  every mint in each block, compute `color = tokenType(domainSep, contractAddress)` …").
- **Problem**: "every mint in each block" does not say where a mint is read from or which mints count. A raw
  transaction carries each contract call's declared effects (`shieldedMints` / `unshieldedMints`: `domainSep →
  amount`) in BOTH its guaranteed and its fallible transcript, and the bytes are on chain even when the fallible
  segment failed or the whole transaction failed — those mints never happened. Two other tempting sources are wrong
  for the table: MIP-0002 `ShieldedMint` / `UnshieldedMint` events are emitted by the contract (any values, or none
  at all), and an unshielded UTXO's `tokenType` is the color but does not name the minting contract.
- **Evidence**: `packages/midnight/src/raw.ts` / `scanner.ts` (S4): decoding with ledger-v9 1.0.0-rc.5 shows the
  effects per transcript; the indexer's `transactionResult { status segments { id success } }` tells which parts were
  applied (midnight-ledger `semantics.rs`: guaranteed part applies unless the transaction fails; a fallible segment's
  effects apply only if that segment succeeds). Recorded Stagenet mints (`packages/midnight/test/fixtures/stagenet/
  mint-txs.json`, blocks 508540 / 508544) decode to the color the indexer serves as the UTXO `tokenType`; the local
  end-to-end run checks every mint of the run appears once with the right `(contract, domainSep, kinds)`.
- **Further evidence (examples and CLI)**: a published-but-never-minted identity (token-family bronze) is colored by the consumer (kind 1) but `lookup` answers "not minted in the scanned range" (exit 3): the color a consumer derives and the colors that exist on chain are different sets, as N10 says. **Stagenet (case [IDX](deployments/stagenet/cases/IDX/README.md), 2026-10-02)**: the scanner read blocks 714485–715183 (699 blocks, 58 contract calls, 0 decode errors) and found exactly the 7 applied mints of the matrix (5 colors) plus one mint of another Stagenet contract; bronze (C05, published, never minted) is "not minted in the scanned range"; every minted color's entry equals the wallet SDK's own view of the coins/UTXOs wallet 1 received (`wallet-status.json` of C02–C05).
- **Proposed text** (Lookup, informative): "A mint is a `shieldedMints` or `unshieldedMints` effect of a contract
  call in a part of the transaction that was applied: the guaranteed part of a transaction that did not fail, or a
  fallible segment that succeeded. Mint events a contract emits (MIP-0002 `ShieldedMint` / `UnshieldedMint`) and
  UTXO token types are not sources for this table."
- **Meanwhile**: `mip0018 index` counts exactly those mints (`partApplied` in `raw.ts`) and ignores emitted mint
  events.
- **Status**: PROPOSED

## N11 — "Event within the transaction": name the order a raw-transaction reader must use

- **MIP section**: Applying records ("chain order: block, transaction within the block, event within the
  transaction, then record within the event").
- **Problem**: an indexer gives events in its own id order, but a consumer that reads raw transactions (or a node)
  must order the events of one transaction itself, and a transaction can hold several intents (segments) with
  guaranteed and fallible parts. The MIP does not say what "event within the transaction" means then.
- **Evidence**: midnight-ledger `semantics.rs` applies the guaranteed part of every intent first (intents in
  ascending segment id, actions in intent order, operations in program order), then each fallible segment in
  ascending segment id; the indexer stores events in that order (its ids follow it), and MIP-0002's `EventSource
  { logicalSegment, physicalSegment }` carries the segment. `packages/midnight/src/raw.ts` orders decoded `log`
  operations that way; the local end-to-end run checks that the scanner's per-contract events equal the indexer's,
  byte for byte and in order.
- **Proposed text** (Applying records, informative, or MIP-0002): "Within a transaction, events are in the ledger's
  execution order: the guaranteed part of every intent (in ascending segment id), then each successful fallible
  segment (in ascending segment id); within a part, actions and their operations in order."
- **Meanwhile**: `raw.ts` uses that order; indexer-based commands use the indexer's event id.
- **Status**: PROPOSED

## N12 — Common fields: getter equality when the getters cannot change and the token is renamed

- **MIP section**: Common fields ("A token that also exposes MIP-0004, MIP-0011 or MIP-0014 getters SHOULD emit the same values those getters return") and Publishing ("… and for extraordinary updates, such as a rename").
- **Problem**: the MIP's own adoption targets (Implementation Plan step 4: OpenZeppelin `NativeShieldedToken`, `NativeShieldedTokenFamily`, `FungibleToken`) store `name` and `symbol` as `sealed` ledger fields: the getters can never change after deployment. Any MIP-0018 rename of such a token therefore emits values its getters do not return — the rename the Publishing section allows breaks the Common-fields SHOULD. A reader cannot tell which wins, and an issuer cannot both rename and conform.
- **Evidence**: `examples/openzeppelin/*/contracts/*.compact` (OpenZeppelin 0.4.0-alpha.5): `setMetadata` renames; the runtime tests show the event state after a rename while `name()` / `symbol()` keep the constructor values (`_name`/`_symbol` are `export sealed ledger … Opaque<"string">` in `NativeShieldedTokenCore` and `FungibleToken`). The equality itself cannot be checked in circuit (`Opaque<"string">` cannot be converted to bytes; findings F6).
- **Options** (considered):

  | Option | Text | Effect |
  |---|---|---|
  | (a) Getter equality at first publication | "… SHOULD emit the same values those getters return when it first publishes them. A later rename is the token's current metadata for consumers of this MIP, even where the getters cannot change." | Renames of OpenZeppelin tokens conform; wallets that also read getters know which wins |
  | (b) No renames for immutable getters | "A token whose getters cannot change SHOULD NOT rename through these events." | Keeps the SHOULD absolute; OpenZeppelin tokens can never rename |
  | (c) No change | — | The two sentences stay in tension |

- **Meanwhile**: the examples publish the constructor literals (getter-consistent) and document that a rename supersedes the `sealed` getters (`examples/openzeppelin/README.md`, "Renames do not change the getters").
- **Decision for this repository** (project owner, 2026-10-02): option (a). Getter equality applies when a token first publishes its metadata; MIPs that define specific token standards may define how their tokens behave and override MIP-0018's defaults case by case.
- **Proposed text** (Common fields, replacing the getter sentence): "A token that also exposes MIP-0004, MIP-0011 or MIP-0014 getters SHOULD emit the same values those getters return when it first publishes them. A later update, such as a rename, is the token's current metadata for consumers of this MIP even where the getters cannot change. A MIP that defines a token standard MAY restrict or override these defaults for its tokens."
- **Status**: PROPOSED

## N13 — Payload: a fixed-size field must be exactly as long as its key or value

- **MIP section**: Payload ("Keys and values are exact byte strings … zero bytes inside a key or value are significant" and "a Compact emitter builds each payload from fixed-size fields (for example `Uint<8>` lengths and `Bytes<K>` keys)").
- **Problem**: the natural Compact mistake — a `Bytes<K>` wider than the text it carries — appends zero bytes that become part of the key or value (`"AGL"` in a `Bytes<4>` is `"AGL\0"`). The result is still a valid payload (NUL is valid UTF-8), so consumers accept it and show a different symbol, or treat a padded key as an unknown key. Nothing in the payload rules catches it; only the emitter can prevent it. (Found independently by the scripts and examples slices of this repository.)
- **Evidence**: `examples/openzeppelin/test/exact-values.test.ts` — with this repository's module a literal of the wrong length does not compile, and compact-runtime 0.20.0 refuses a too-short argument (`expected value of type Bytes<9>`), but a rename argument zero-padded to the circuit's size is emitted as `"Short\0\0\0\0"` and accepted by the reference codec; every example now decodes every emitted event and compares each value with its `metadata.json` exactly.
- **Further evidence (examples and CLI)**: the tooling side now enforces it too: the CLI's `{"$utf8": "…"}` argument for a `Bytes<N>` circuit parameter must be exactly N bytes; a shorter text is refused ("zero padding would become part of the value") unless `"pad": true` asks for padding on purpose (`packages/midnight/src/signer/args.ts`, unit test in `packages/midnight/test/signer-units.test.ts`). Every rename in the examples' adapters, the walkthrough and the Stagenet cases goes through this rule.
- **Proposed text** (informative, after the Compact sentence of the Payload section): "Each fixed-size field must be exactly as long as the key or value it carries: a shorter value padded with zero bytes is a different value (for example `"AGL"` sent as a `Bytes<4>` is `"AGL\0"`), and consumers accept it as such."
- **Meanwhile**: the module's typed builders take the sizes as generic arguments checked by the compiler; the OpenZeppelin README says "never pad a value with zeros"; tests compare every emitted value exactly.
- **Status**: PROPOSED (informative)

## N14 — Implementation Plan step 4: say where kind 2 comes from

- **MIP section**: Implementation Plan, step 4 ("Propose the module to OpenZeppelin Compact Contracts as an optional extension of `NativeShieldedToken`, `NativeShieldedTokenFamily` and `FungibleToken`").
- **Problem**: the list covers kinds 1 and 3 only. OpenZeppelin Compact Contracts 0.4.0-alpha.5 has no native unshielded (MIP-0014, kind 2) module on `main` (earlier `NativeUnshieldedToken` drafts exist only on stale branches for an older ledger), so an OpenZeppelin user has no base for a kind-2 token, and readers may assume kind 2 is not meant to be covered.
- **Evidence**: `examples/openzeppelin/native-unshielded` and `multi-kind` use the standard library's `mintUnshieldedToken` with OpenZeppelin `Ownable`; the module works for kind 2 unchanged (runtime tests: the minted UTXO's color equals `tokenType(domainSep, contractAddress)` and the consumer's color). All three listed modules take the extension unchanged (compile with Compact 0.35.0 + ZKIR v3 against 0.4.0-alpha.5, no compiler message).
- **Proposed text**: "… as an optional extension of `NativeShieldedToken`, `NativeShieldedTokenFamily` and `FungibleToken`, and of a native unshielded token module once the library has one (until then, kind 2 tokens call `mintUnshieldedToken` directly)."
- **Meanwhile**: documented in `examples/openzeppelin/native-unshielded/README.md`. Nothing is proposed to OpenZeppelin from this repository (owner decision Q6).
- **Status**: PROPOSED (editorial)

## N15 — Existing contracts, step 1: say what "against the contract's existing ledger layout" requires, and that nothing on chain checks it

- **MIP section**: Backwards Compatibility Assessment — Existing contracts, step 1 ("Compile a `publishMetadata()` circuit … against the contract's existing ledger layout. It reads the existing `domain` from state and emits it as `domainSep`.").
- **Problem**: Compact assigns ledger state paths by declaration order (the contract's fields and those of imported modules). The new circuit reads the deployed state through the paths of the source it was compiled from; the ledger has no notion of field names or types, so a source with a different layout is accepted on chain and reads other fields. The MIP does not say this, and the failure is silent.
- **Evidence**: `test/upgrade.test.ts` (compact-runtime 0.20.0, one shared state as on chain after the insert): an upgrade source with `domain` and `owner` swapped (both `Bytes<32>`) compiles; its `ledger()` reads other values under the same names; its owner check reads the domain (owner refused); an unguarded variant emits an **accepted** event whose `domainSep` is the owner's id — metadata for an identity nobody holds. `test/layout.test.ts`: the compiler's recorded layout (`compiler/contract-info.json` → `ledger`) detects reorder, rename, retype, other storage, missing/extra fields and imported modules with ledger fields.
- **Proposed text** (step 1, after the first sentence): "The source MUST declare the deployed contract's ledger fields — including those of the modules it imports — exactly as deployed: the same fields, in the same order, with the same types. The ledger does not check this; a different layout makes the circuit read other state, for example a `domainSep` that is not the token's. Compilers record the layout they chose, so tools can compare the two builds before the update is signed."
- **Meanwhile**: `scripts/check-layout.ts` and `mip0018 upgrade` compare the compiled layouts and decode the deployed state through both builds before signing.
- **Status**: PROPOSED

## N16 — Existing contracts: "does not need redeployment" holds only with a usable maintenance authority

- **MIP section**: Backwards Compatibility Assessment — Existing contracts ("A contract deployed before then has no emitting circuit, but it does not need redeployment: its maintenance authority can add one.").
- **Problem**: a contract's maintenance authority may be frozen: an empty committee (the ledger default), a threshold above the committee size, or keys nobody holds any more. Such a contract can never take a maintenance update, so it cannot add a circuit.
- **Evidence**: ledger 9.1.0.0-rc.3 — `ContractMaintenanceAuthority` default is an empty committee with threshold 1; verification requires `signatures ≥ threshold` from committee keys (`ledger/src/verify.rs`). Local run: an insert signed by a key outside the one-key committee is refused by `mip0018 upgrade` before submission and, forced, rejected by the node with `1010: Invalid Transaction: Custom error: 135` (`MalformedError::InvalidCommitteeSignature`, midnight-node `ledger/src/versions/common/types.rs`), nothing changed (README "Local run"); unit tests of `checkAuthority`. The same on Stagenet (case [U1](deployments/stagenet/cases/U1/README.md), 2026-10-02): refused before submission, and forced, rejected by the node with `Custom error: 135`, not included, no fee.
- **Proposed text**: "… but it does not need redeployment if its maintenance authority can still sign: its maintenance authority can add one. A contract whose authority is frozen (an empty committee, an unreachable threshold, or lost keys) cannot add a circuit and needs a new deployment to adopt this MIP."
- **Meanwhile**: `checkAuthority` refuses frozen authorities, foreign keys and thresholds above 1 before anything is submitted; the upgrade guide lists the check.
- **Status**: PROPOSED

## N17 — Existing contracts, step 2: inserting never replaces; what an upgrade cannot add

- **MIP section**: Backwards Compatibility Assessment — Existing contracts, steps 1–2; Publishing ("SHOULD be access-controlled or publish-once").
- **Problem**: two practical limits are not stated. (1) `VerifierKeyInsert` never replaces a key already present for that entry point and version (`VerifierKeyAlreadyPresent`), and maintenance updates apply only in a fallible segment, so an insert over an existing `publishMetadata` is included, charged and refused. Changing the circuit takes a `VerifierKeyRemove` first. (2) The deployed state has no room for new ledger fields, so the Publishing section's "publish-once" pattern is impossible for an added circuit; it can reuse the contract's existing access control, or use a constant payload and be removed after the call.
- **Evidence**: local run (README "Local run"): re-inserting the same key and inserting another build's `publishMetadata` key are both refused by `mip0018 upgrade` before submission and, forced, included as `PARTIAL_SUCCESS` (the fallible segment with the update failed; fees ≈ 0.60 DUST each, the same as a successful insert); the key, the authority counter and the ledger data stay unchanged. `test/layout.test.ts`: adding a `published: Boolean` field (a publish-once flag) breaks the layout.
- **Proposed text** (informative, after step 2): "A `VerifierKeyInsert` never replaces an existing key; to change an added circuit, remove its key first. An added circuit cannot add ledger fields, so it cannot be made publish-once; guard it with the contract's existing access control, or give it a constant payload and remove its key after the call."
- **Meanwhile**: the template reuses the token's owner check; `mip0018 upgrade` refuses an insert over another key before submission.
- **Status**: PROPOSED

## N18 — Security Considerations: the maintenance authority controls the metadata too

- **MIP section**: Security Considerations (Unauthorized updates) and Backwards Compatibility ("the update needs no permission beyond what the issuer already reserved").
- **Problem**: the same authority that adds `publishMetadata()` can remove and insert any circuit at any time, including the emitting circuits and their access checks. For a contract with a live maintenance authority, whoever holds it can rename or withdraw the token regardless of the emitting circuit's guard. Consumers and issuers should know this when they judge who controls a token's metadata.
- **Evidence**: ledger semantics of `VerifierKeyRemove` / `VerifierKeyInsert` (any entry point); the local run inserts a circuit into a deployed token with the deploy-time key alone.
- **Proposed text** (Unauthorized updates, new sentence): "A contract's maintenance authority can replace its emitting circuits, so it can change the metadata as well; metadata is fixed only when no one can call an emitting circuit and no one holds the maintenance authority." (Whether and how an authority can be given up — e.g. a `ReplaceAuthority` to an empty committee — was not exercised here.)
- **Meanwhile**: documented in `docs/upgrade-guide.md` (Limits: Trust).
- **Status**: WITHDRAWN (project owner, 2026-10-02: possible, but it cannot be verified in circuit — an implementation design question, not part of the MIP; kept in `docs/upgrade-guide.md`, Limits: Trust)

## N19 — Spam and cost: give issuers the order of magnitude of a metadata transaction

- **MIP section**: Security Considerations — "Spam and cost" ("Events pay the existing `Log` fee and compete for each
  block's `bytes_written` budget").
- **Problem**: the sentence names the fee mechanism but not its size, so an issuer cannot tell whether publishing,
  renaming or withdrawing is cheap enough to do routinely, and a reviewer cannot judge the spam bound. Two facts are
  not obvious: the fee of a metadata transaction hardly depends on the emitting circuit's size, and most of an
  issuer's cost is at deployment (one verifier key per circuit).
- **Evidence** (Stagenet, ledger 9.1.0.0-rc.3, 2026-10-02; receipts in each case's `record.json`, table in
  [`docs/costs.md`](docs/costs.md#fees-on-stagenet)): every transaction emitting one MIP-0018 event cost
  0.169–0.179 DUST whatever its circuit (k = 6 literal A1 … k = 16 raw emitter; full 256-byte payloads and short ones
  alike — the 34 single-event transactions of C01–C10 plus S0-SPIKE); one call emitting three events 0.193 DUST (C04); two events 0.181 (C08); a tombstone
  0.174 (C06). Deploying the tokens cost 1.5 DUST (1 circuit) to 7.0 DUST (10 circuits, OpenZeppelin), i.e.
  ≈ 0.6–0.9 DUST per additional verifier key; adding one later with a `VerifierKeyInsert` 0.911 DUST (U1); a
  `VerifierKeyRemove` 0.039 DUST.
- **Proposed text** (informative, after the Spam-and-cost sentence): "For orientation: on Midnight Stagenet
  (ledger 9.1) a transaction that emits one metadata event cost about 0.17 DUST in 2026, largely independent of the
  emitting circuit's size or the payload's length; each emitting circuit adds its verifier key to the contract's
  deployment cost."
- **Meanwhile**: `docs/costs.md` publishes the measured figures (local and Stagenet) with the circuit sizes.
- **Status**: PROPOSED (informative; figures are network- and time-dependent, so the authors may prefer to link a
  measurement instead of quoting numbers)

---

## Considered — no change proposed

| Topic | Decision |
|---|---|
| JSON details for `valType` 3 (BOM, surrounding whitespace, duplicate names) | Each consumer uses its own JSON parser; mainstream parsers converge. No change. |
| No upper bound on `decimals` | Not a limit for this MIP; the standards a token follows define good practice. No change. |
| Events from failed transaction segments | Consumers only ever see events the ledger accepted and executed. No change. |
| Getter equality ("SHOULD emit the same values those getters return") cannot be checked today | Enforceable once contract getters can be executed by consumers. No change. |
| Color lookup needs mint data the public indexer does not expose | The MIP already assigns this to indexers; this repository ships a reference scanner that builds the color table from a start block. No change. |
| Circuit cost of emitting (S2 measurements: a constant payload costs only the `emit`, k = 6 / 48 rows; any runtime byte, even a `domainSep` read from the ledger, k = 14 / ≈ 14,000 rows; four runtime common fields k = 15) | Implementation guidance, not protocol: documented in `docs/costs.md` and the module README. No change. |
| An empty key (`keyLen` 0) is a valid Compact generic size (`Bytes<0>`) | Emitter-library concern: the reference module makes it a compile error (`slice<1>(key, 0)` guard). The MIP's "1–255" stands. No change. |
| OpenZeppelin's `NativeShieldedTokenFamily` keeps one family-wide name/symbol ("one brand"); published getter-consistently, all types of a family fall into one symbol group | The MIP already says grouping is presentation only and does not make members interchangeable; an issuer who wants separate groups gives each type its own symbol (`setMetadata(domain, …)` in `examples/openzeppelin/token-family`). No change. |
| One asset in three kinds needs three events (one per identity): one circuit emitting all three costs k = 16 (≈ 57,000 rows) vs k = 15 per single-event call | By design (each kind has its own lifecycle, MIP Rationale "A `kind` byte"). Documented in `examples/openzeppelin/multi-kind`. No change. |
| OpenZeppelin claims no MIP standard, so the examples publish no `standards` (questions Q25) | `standards` is self-declared by design. No change. |
| Pre-v9 (ledger 8) contracts and the upgrade path | The MIP's "a contract deployed before then" includes contracts deployed under ledger 8. Whether such a contract (midnight-js calls them "retained era") accepts a ZKIR-v3 (`v4`) key and the call is not verified here: the local chain and Stagenet run ledger v9 from genesis. No text change proposed without evidence. |
| An access-control failure leaves no trace on chain | OpenZeppelin `Ownable` (and the minimal owner key) assert inside the circuit, so a non-owner's call fails while the transaction is built: nothing is submitted, paid or emitted (C09, local evidence). Consumers never see such attempts, so the MIP needs no rule about them; the issuer guide says it. |
| Re-publishing identical values or repeating a tombstone | Changes no consumer state (vectors S2/S3b already say so). Whether an issuer's tool skips such a transaction is tooling (Q27: `mip0018 publish` skips it unless `--force`; negative events are never skipped). |
